import {RealtimeVoiceClient} from '../src/realtime';
import {getSnapshot,sendCommand,generation} from '../src/api';
import {uid} from '../src/state';
import type {Snapshot,Binding} from '../src/types';
let state:Snapshot;let client:RealtimeVoiceClient|null=null;let audioContext:AudioContext|null=null;
const bindings=new Map<string,Binding>();const output=document.querySelector('#result')!;
const log=(message:string)=>{output.textContent+='\n'+new Date().toISOString()+' '+message;};
const buttons=['review','context','reconnect','stop'];
async function connect(){
 state=await getSnapshot();bindings.clear();audioContext=new AudioContext();
 const audio=audioContext.createMediaStreamDestination();
 client=new RealtimeVoiceClient({
  onStatus:(status,detail)=>{log('Voice: '+status+(detail?' · '+detail:''));},
  onLatency:(metric,ms)=>log(metric+': '+ms.toFixed(0)+'ms'),
  onResponseStarted:(id)=>{
   const b:Binding={epoch:state.epoch,version:state.state_version,ui:state.ui_revision,cancelled:false,ready:Promise.resolve()};
   b.ready=generation({command_id:uid('smoke_begin'),response_id:id,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,cancelled:false});void b.ready.catch(()=>undefined);bindings.set(id,b);
  },
  onInterruption:(id)=>{if(!id)return;const b=bindings.get(id);if(!b)return;b.cancelled=true;void generation({command_id:uid('smoke_cancel'),response_id:id,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,cancelled:true});},
  onToolCall:async(args,callId,responseId)=>{
   const b=bindings.get(responseId)!;await b.ready;if(b.cancelled)throw new Error('Interrupted');
   state=await sendCommand({command_id:'smoke_'+callId,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,source:'realtime',kind:'intent',response_id:responseId,payload:args});
   log(`PASS: actual Realtime tool ${args.action} accepted; surface=${state.surface.mode}, items=${state.surface.item_ids.join(',')}, state v${state.state_version}, grill=${state.capacity.value}, offer=${state.offer?.status??'none'}, order=${state.order?.status??'none'}`);
   return {ok:true,accepted_result:state};
  }
 });
 await client.connect(state,{stream:async()=>audio.stream,muteOutput:true,greet:false});
 log(`PASS: live WebRTC connected with restored state v${state.state_version}, surface=${state.surface.mode}, order=${state.order?.status??'none'}`);
 buttons.forEach(id=>(document.querySelector('#'+id) as HTMLButtonElement).disabled=false);
}
function run(fn:()=>Promise<void>){void fn().catch(e=>log('FAIL: '+e.message));}
document.querySelector('#start')!.addEventListener('click',()=>run(async()=>{client?.disconnect();await audioContext?.close();await connect();client!.verificationText('This is synthetic verification. Just me today. Show the lemon-herb chicken on screen, food ready within 12 minutes. Use the detail tool.');}));
document.querySelector('#review')!.addEventListener('click',()=>{client?.verificationText('I am one diner. I would like to review the mushroom bowl, no modifiers, ready within 12 minutes. Please show the exact pending review; do not confirm it yet.');});
document.querySelector('#context')!.addEventListener('click',()=>run(async()=>{state=await getSnapshot();client!.syncContext(state,'synthetic_external_check');client!.verificationText('Use the current authoritative state. Compare the chicken and mushroom bowl, explaining the current grill capacity and current timings. Do not confirm any order.');}));
document.querySelector('#reconnect')!.addEventListener('click',()=>run(async()=>{client?.disconnect();await audioContext?.close();await connect();client!.verificationText('We reconnected. Show my current order status from restored application context. Do not create or confirm any order.');}));
document.querySelector('#stop')!.addEventListener('click',()=>run(async()=>{log('TRANSPORT EVIDENCE: '+JSON.stringify(await client!.diagnostics()));client?.disconnect();await audioContext?.close();log('Stopped. No microphone used, no audio/transcript file saved.');buttons.forEach(id=>(document.querySelector('#'+id) as HTMLButtonElement).disabled=true);}));
