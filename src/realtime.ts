// Adapted neutral WebRTC transport; restaurant tools and generation lifecycle are event work.
import {intentSchema,type VoiceIntent} from './types';
export type VoiceStatus='idle'|'requesting-microphone'|'connecting'|'connected'|'listening'|'responding'|'disconnected'|'error';
interface Callbacks {
 onStatus:(s:VoiceStatus,detail?:string)=>void;
 onResponseStarted:(id:string)=>void;
 onInterruption:(id:string|null)=>void;
 onToolCall:(args:VoiceIntent,id:string,responseId:string)=>Promise<object>;
 onLatency:(name:string,ms:number)=>void;
}
interface ServerEvent {type?:string;response_id?:string;response?:{id?:string};call_id?:string;name?:string;arguments?:string;item?:{call_id?:string;name?:string;arguments?:string};error?:{message?:string}}
export class RealtimeVoiceClient {
 private peer:RTCPeerConnection|null=null;private channel:RTCDataChannel|null=null;
 private microphone:MediaStream|null=null;private audio:HTMLAudioElement|null=null;
 private activeResponseId:string|null=null;private cancelled=new Set<string>();private handled=new Set<string>();
 private responding=false;private latestContext:object|null=null;private closed=false;
 private pendingNarration=false;private toolPending=0;private audioResponseId:string|null=null;
 private retiringResponseId:string|null=null;private narrationInstructions:string|undefined;
 private userSpeaking=false;private awaitingResponse=false;private playingResponses=new Set<string>();
 constructor(private callbacks:Callbacks){}
 async connect(context:object, verification?:{stream:()=>Promise<MediaStream>;muteOutput:boolean;greet:boolean}):Promise<void>{
  this.latestContext=context;this.closed=false;this.callbacks.onStatus('requesting-microphone');
  this.microphone=verification?await verification.stream():await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  if(this.closed){this.microphone.getTracks().forEach(t=>t.stop());return;}
  const started=performance.now();this.callbacks.onStatus('connecting');
  const peer=new RTCPeerConnection();this.peer=peer;const audio=document.createElement('audio');audio.autoplay=true;audio.muted=verification?.muteOutput??false;this.audio=audio;
  peer.ontrack=({streams})=>{audio.srcObject=streams[0];};
  peer.onconnectionstatechange=()=>{if(['failed','disconnected'].includes(peer.connectionState))this.callbacks.onStatus('disconnected','Connection lost. Reconnect restores your current order.');};
  this.microphone.getAudioTracks().forEach(t=>peer.addTrack(t,this.microphone!));
  const channel=peer.createDataChannel('oai-events');this.channel=channel;
  channel.addEventListener('message',({data})=>{try{void this.handleEvent(JSON.parse(String(data)));}catch{this.callbacks.onStatus('error','Invalid voice event. Please reconnect.');}});
  channel.addEventListener('close',()=>{if(!this.closed)this.callbacks.onStatus('disconnected');});
  const open=new Promise<void>((resolve,reject)=>{
   const timeout=window.setTimeout(()=>reject(new Error('Voice connection timed out. Please try again.')),20000);
   channel.addEventListener('open',()=>{window.clearTimeout(timeout);resolve();},{once:true});
   channel.addEventListener('close',()=>{window.clearTimeout(timeout);reject(new Error('Voice connection closed.'));},{once:true});
  });
  // Install a handler immediately so SDP failures cannot leave an unhandled timer rejection.
  void open.catch(()=>undefined);
  const offer=await peer.createOffer();await peer.setLocalDescription(offer);
  const response=await fetch('/api/realtime/calls',{method:'POST',headers:{'Content-Type':'application/sdp'},body:peer.localDescription?.sdp??offer.sdp});
  if(!response.ok){const error=await response.json().catch(()=>({detail:'Voice connection failed.'}));throw new Error(error.detail);}
  if(this.closed)return;
  await peer.setRemoteDescription({type:'answer',sdp:await response.text()});await open;
  this.sendContext(this.latestContext!,'connection_restore');this.callbacks.onLatency('connect',performance.now()-started);
  if(verification?.greet!==false)this.requestResponse('Greet Alex warmly as Mira. Mention that they loved the chicken biryani last time, then ask what sounds good today. Do not assume they want chicken again. Keep it to two short sentences.');
  else this.resumeListening();
 }
 private send(event:object){if(this.channel?.readyState==='open'&&!this.closed)this.channel.send(JSON.stringify(event));}
 private resumeListening(){
  if(this.closed||this.userSpeaking||this.responding||this.awaitingResponse||this.toolPending||this.pendingNarration||this.retiringResponseId||this.playingResponses.size)return;
  this.callbacks.onStatus('connected');
 }
 private requestResponse(instructions?:string){
  this.awaitingResponse=true;this.callbacks.onStatus('responding');
  this.send(instructions?{type:'response.create',response:{instructions}}:{type:'response.create'});
 }
 private sendContext(context:object,reason:string){this.send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:`[Authoritative DineOS state update: ${reason}. Context only; never consent.] ${JSON.stringify(context)}`}]}});}
 syncContext(context:object,reason='external_update',announce=false){
  this.latestContext=context;
  if(announce){this.invalidateResponse();this.pendingNarration=true;this.narrationInstructions='Briefly explain the latest authoritative kitchen/order change using actual current state. A pending request is not an acknowledgment. Do not order anything or repeat a tool just to narrate.';}
  this.sendContext(context,reason);
  this.flushNarration();
 }
 private flushNarration(){
  if(!this.pendingNarration||this.userSpeaking||this.responding||this.awaitingResponse||this.toolPending||this.retiringResponseId||this.closed)return;
  const instructions=this.narrationInstructions;this.pendingNarration=false;this.narrationInstructions=undefined;
  this.requestResponse(instructions);
 }
 private async handleToolCall(event:ServerEvent){
  const id=event.call_id??event.item?.call_id;const name=event.name??event.item?.name;
  const responseId=event.response_id; // Never fall back to a newer active response.
  if(!id||name!=='dineos_intent'||this.handled.has(id))return;
  this.handled.add(id);this.toolPending++;
  const started=performance.now();let result:object;
  try{
   if(!responseId||this.cancelled.has(responseId)||this.closed)throw new Error('Interrupted or unbound voice tool rejected.');
   const args=intentSchema.parse(JSON.parse(event.arguments??event.item?.arguments??'{}'));
   result=await this.callbacks.onToolCall(args,id,responseId);
  }catch(e){result={ok:false,error:e instanceof Error?e.message:'Invalid tool arguments.',authoritative_state:this.latestContext};}
  this.toolPending--;this.callbacks.onLatency('tool',performance.now()-started);
  this.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:id,output:JSON.stringify(result)}});
  // Recheck AFTER awaiting: interruption while an HTTP command is in flight must not restart speech.
  if(responseId&&!this.cancelled.has(responseId)&&!this.closed){
   this.pendingNarration=true;
  }
  this.flushNarration();
  this.resumeListening();
 }
 private async handleEvent(e:ServerEvent){
  if(this.closed)return;
  if(e.type==='response.created'&&e.response?.id){this.awaitingResponse=false;this.activeResponseId=e.response.id;this.audioResponseId=e.response.id;this.responding=true;this.callbacks.onResponseStarted(e.response.id);this.callbacks.onStatus('responding');}
  else if(e.type==='input_audio_buffer.speech_started'){
   this.userSpeaking=true;this.awaitingResponse=false;this.invalidateResponse();
   this.callbacks.onStatus('listening');
  }
  else if(e.type==='input_audio_buffer.speech_stopped'){
   this.userSpeaking=false;this.awaitingResponse=true;this.callbacks.onStatus('responding');
  }
  else if(e.type==='output_audio_buffer.started'&&e.response_id){
   if(this.cancelled.has(e.response_id))return;
   this.playingResponses.add(e.response_id);this.callbacks.onStatus('responding');
   void this.audio?.play().catch(()=>undefined);
  }
  else if((e.type==='output_audio_buffer.stopped'||e.type==='output_audio_buffer.cleared')&&e.response_id){
   this.playingResponses.delete(e.response_id);this.resumeListening();
  }
  else if(e.type==='response.function_call_arguments.done'||e.type==='response.output_item.done')await this.handleToolCall(e);
  else if(e.type==='response.output_audio.delta'||e.type==='response.output_audio_transcript.delta'){
   const id=e.response_id??this.audioResponseId;if(id&&!this.cancelled.has(id))void this.audio?.play().catch(()=>undefined);
  }else if(e.type==='response.done'){
   if(e.response?.id===this.retiringResponseId){this.retiringResponseId=null;this.flushNarration();this.resumeListening();return;}
   if(e.response?.id&&e.response.id!==this.activeResponseId)return;
   // response.done ends generation; WebRTC audio may still be playing.
   this.responding=false;this.activeResponseId=null;
   this.flushNarration();this.resumeListening();
  }else if(e.type==='error'){
   const message=e.error?.message??'Voice session reported an error.';
   if(!message.includes('no active response')){this.disconnect();this.callbacks.onStatus('error',message);}
  }
 }
 private invalidateResponse(){
  const id=this.activeResponseId??this.audioResponseId;
  if(id&&!this.cancelled.has(id)){this.cancelled.add(id);this.callbacks.onInterruption(id);}
  this.pendingNarration=false;this.narrationInstructions=undefined;
  if(this.responding){this.retiringResponseId=this.activeResponseId;this.send({type:'response.cancel'});}
  if(this.responding||this.playingResponses.size)this.send({type:'output_audio_buffer.clear'});
  this.audio?.pause();this.responding=false;this.activeResponseId=null;
 }
 // Used by the explicitly labeled synthetic live verification page, not a visible diner text UI.
 verificationText(text:string){this.send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}});this.requestResponse();}
 async diagnostics(){let audioBytes=0;const stats=await this.peer?.getStats();stats?.forEach(r=>{if(r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio'))audioBytes+=r.bytesReceived??0;});return {connection:this.peer?.connectionState,channel:this.channel?.readyState,inbound_audio_bytes:audioBytes};}
 interrupt(){this.invalidateResponse();this.resumeListening();}
 disconnect(){
  this.invalidateResponse();this.closed=true;this.pendingNarration=false;this.retiringResponseId=null;this.narrationInstructions=undefined;this.userSpeaking=false;this.awaitingResponse=false;this.playingResponses.clear();
  this.microphone?.getTracks().forEach(t=>t.stop());this.channel?.close();this.peer?.close();
  this.audio?.pause();if(this.audio)this.audio.srcObject=null;
  this.channel=null;this.peer=null;this.microphone=null;this.callbacks.onStatus('disconnected');
 }
}
