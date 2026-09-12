import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,AudioLines,CheckCircle2,ChefHat,ChevronRight,Info,Mic,RotateCcw,Square,Utensils,X,WifiOff} from 'lucide-react';
import {ApiError,getHealth,getSnapshot,sendCommand,generation} from './api';
import {acceptSnapshot,commandFor,uid} from './state';
import {intent,type Snapshot,type VoiceIntent,type Health,type Binding,type Command} from './types';
import {RealtimeVoiceClient,type VoiceStatus} from './realtime';
import DinerSurface from './components/DinerSurface';
import KitchenPanel from './components/KitchenPanel';

function context(s:Snapshot){return {epoch:s.epoch,state_version:s.state_version,ui_revision:s.ui_revision,diner:s.diner,menu:s.menu,capacity:s.capacity,offer:s.offer,order:s.order,surface:s.surface,decision:s.decision,planner:s.planner,exceptions:s.exceptions,actions:s.actions,active_sequence:s.active_sequence,timeline:s.timeline};}
export default function App(){
 const [s,setS]=useState<Snapshot|null>(null);const ref=useRef<Snapshot|null>(null);
 const [health,setHealth]=useState<Health|null>(null);const [demo,setDemo]=useState(true);const [busy,setBusy]=useState(false);
 const [notice,setNotice]=useState('');const [connectionError,setConnectionError]=useState(false);const [about,setAbout]=useState(false);
 const [voiceStatus,setVoiceStatus]=useState<VoiceStatus>('idle');const [voiceDetail,setVoiceDetail]=useState('');
 const voice=useRef<RealtimeVoiceClient|null>(null);const bindings=useRef(new Map<string,Binding>());const connectionEpoch=useRef(0);
 const [latency,setLatency]=useState<string>('');
 const apply=useCallback((next:Snapshot,origin='poll')=>{
  setConnectionError(false);
  const old=ref.current;const accepted=acceptSnapshot(old,next);if(accepted===old)return;
  ref.current=accepted;setS(accepted);setConnectionError(false);
  const last=next.actions.at(-1);const oldLast=old?.actions.at(-1);
  const newAck=!!last&&last.status!=='requested'&&(last.id!==oldLast?.id||last.status!==oldLast?.status);
  const changedEpoch=old&&old.epoch!==next.epoch;
  if(changedEpoch){voice.current?.disconnect();bindings.current.clear();setNotice('A fresh service is ready. Start voice to reconnect.');}
  else voice.current?.syncContext(context(next),origin,origin!=='tool'&&newAck);
 },[]);
 useEffect(()=>{
  let stopped=false;let polling=false;let healthPoll=0;
  Promise.all([getSnapshot(),getHealth()]).then(([state,h])=>{if(!stopped){apply(state,'restore');setHealth(h);}}).catch(()=>{if(!stopped)setConnectionError(true);});
  const timer=window.setInterval(async()=>{if(stopped||polling)return;polling=true;try{const next=await getSnapshot();if(!stopped)apply(next);if(++healthPoll%10===0){const h=await getHealth();if(!stopped)setHealth(h);}}catch{if(!stopped)setConnectionError(true);}finally{polling=false;}},500);
  return()=>{stopped=true;window.clearInterval(timer);voice.current?.disconnect();};
 },[apply]);
 const execute=useCallback(async(cmd:Command,origin='click')=>{
  try{const next=await sendCommand(cmd);apply(next,origin);setNotice('');return next;}catch(e){
   if(e instanceof ApiError&&e.snapshot)apply(e.snapshot,'conflict');
   setNotice(e instanceof Error?e.message:'The request could not be applied.');throw e;
  }
 },[apply]);
 const run=async(kind:string,payload:object,source:Command['source']='coordinator')=>{
  if(!ref.current)return;setBusy(true);
  voice.current?.interrupt();
  try{return await execute(commandFor(ref.current,kind,payload,source));}catch{return undefined;}finally{setBusy(false);}
 };
 const sendIntent=(i:VoiceIntent)=>{void run('intent',i,'diner');};
 const connectVoice=async(initial?:Snapshot)=>{
  const state=initial??ref.current;if(!state)return;
  voice.current?.disconnect();bindings.current.clear();const connection=++connectionEpoch.current;
  const client=new RealtimeVoiceClient({
   onStatus:(status,detail)=>{if(connection!==connectionEpoch.current)return;setVoiceStatus(status);setVoiceDetail(detail??'');},
   onLatency:(name,ms)=>{if(name==='connect')setLatency(`Connected in ${(ms/1000).toFixed(1)}s`);},
   onResponseStarted:(id)=>{
    const base=ref.current;if(!base)return;
    const binding:Binding={epoch:base.epoch,version:base.state_version,ui:base.ui_revision,cancelled:false,ready:Promise.resolve()};
    binding.ready=generation({command_id:uid('begin'),response_id:id,epoch:base.epoch,expected_state_version:base.state_version,expected_ui_revision:base.ui_revision,cancelled:false});
    void binding.ready.catch(()=>undefined);bindings.current.set(id,binding);
   },
   onInterruption:(id)=>{
    if(!id)return;const b=bindings.current.get(id);if(!b)return;b.cancelled=true;
    void generation({command_id:uid('cancel'),response_id:id,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,cancelled:true}).catch(()=>undefined);
   },
   onToolCall:async(args,callId,responseId)=>{
    const b=bindings.current.get(responseId);if(!b)throw new Error('Voice response is unbound. Please repeat after reconnecting.');
    await b.ready;if(b.cancelled||connection!==connectionEpoch.current)throw new Error('Interrupted voice tool rejected.');
    const cmd:Command={command_id:`voice_${callId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)}`,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,kind:'intent',source:'realtime',response_id:responseId,payload:args};
    const result=await execute(cmd,'tool');return {ok:true,accepted_result:context(result)};
   }
  });voice.current=client;
  try{await client.connect(context(state));}catch(e){client.disconnect();if(connection===connectionEpoch.current){setVoiceStatus('error');setVoiceDetail(e instanceof Error?e.message:'Voice connection failed.');}}
 };
 const reset=async()=>{const wasActive=!['idle','disconnected','error'].includes(voiceStatus);voice.current?.disconnect();connectionEpoch.current++;const next=await run('reset',{});if(next&&wasActive)await connectVoice(next);};
 const active=!['idle','disconnected','error'].includes(voiceStatus);
 const report=()=>void run('report',{capacity:1,source_id:'cook_maya',source_kind:'human_report',observed_at:new Date().toISOString(),simulated:true,note:'Maya reports one grill slot is unavailable. Please use a single slot.'});
 if(!s)return <div className="loading-shell"><img src="/favicon.svg" width="44" height="44" alt=""/><h1>DineOS</h1><p>{connectionError?'Start the DineOS backend on port 8001. The page will reconnect automatically.':'Setting the table…'}</p></div>;
 return <div className={`app ${demo?'demo-view':'service-view'}`}><header className="topbar"><a className="brand" href="/" aria-label="DineOS home"><img src="/favicon.svg" alt=""/><strong>Dine<span>OS</span></strong><span className="brand-divider"/><small>A little more in sync.</small></a><div className="top-actions"><div className="view-switch" aria-label="View mode"><button className={!demo?'active':''} onClick={()=>setDemo(false)}>Table view</button><button className={demo?'active':''} onClick={()=>setDemo(true)}>Demo view<span/></button></div><button className="icon-button" aria-label="About DineOS" onClick={()=>setAbout(true)}><Info size={18}/></button></div></header>
 <main className="workspace"><section className="diner-stage"><div className="guest-heading"><div><span className="eyebrow">A seat at the table</span><h1>Welcome back, Alex<span>.</span></h1><p>Good food, at your pace. We’ll take care of the details.</p></div><div className="table-tag"><Utensils size={16}/><strong>Table 07</strong><span>Seeded diner</span></div></div>
 <div className="preference-bar"><div><span className="preference-icon"><ClockIcon/></span><span>Food ready within <strong>{s.diner.ready_within_minutes} minutes</strong></span></div>{s.diner.party_size===null?<button disabled={busy} onClick={()=>sendIntent(intent('preference',{party_size:1,item_ids:['chicken']}))}>Just me today<CheckCircle2 size={14}/></button>:<span className="party"><CheckCircle2 size={14}/> Party of one</span>}</div>
 <DinerSurface key={s.epoch} s={s} busy={busy} onIntent={sendIntent}/>
 <div className={`voice-dock ${active?'active':''}`}><div className={`voice-orb ${voiceStatus}`}><AudioLines size={24}/></div><div className="voice-copy"><strong>{voiceStatus==='listening'?'I’m listening.':voiceStatus==='responding'?'A little help from DineOS.':active?'Your table is connected.':'Your voice. Our attention.'}</strong><p>{voiceDetail||(['connecting','requesting-microphone'].includes(voiceStatus)?'Connecting your microphone…':active?'Ask about a dish, make a change, or check your order.':'“I’d like the chicken, ready in about 12 minutes.”')}</p></div>{active?<button className="voice-button connected" onClick={()=>{connectionEpoch.current++;voice.current?.disconnect();setVoiceStatus('disconnected');}}><Square size={14}/>End voice</button>:<button className="voice-button" disabled={!health?.openai_key_configured} onClick={()=>void connectVoice()}><Mic size={16}/>{voiceStatus==='error'||voiceStatus==='disconnected'?'Reconnect voice':'Talk to DineOS'}</button>}</div>
 <div className="diner-footnote"><span><span className={`tiny-dot ${active?'on':''}`}/>{active?'Live voice · '+(latency||'Connected'):'Tap to start. You can interrupt at any time.'}</span><span>Audio isn’t saved by DineOS.</span></div>
 {notice&&<div className="notice" role="status"><Info size={15}/><span>{notice}</span><button aria-label="Dismiss notice" onClick={()=>setNotice('')}><X size={14}/></button></div>}
 {connectionError&&<div className="notice error" role="alert"><WifiOff size={15}/>Connection interrupted. Reconnecting to your saved service state…</div>}
 </section>{demo&&<KitchenPanel key={s.epoch} s={s} busy={busy} onCommand={(kind,payload)=>void run(kind,payload)}/>}</main>
 {demo&&<footer className="demo-controls"><div><span className="demo-badge">LIVE DEMO</span><span>One conversation. A whole kitchen in the loop.</span></div><div className="demo-buttons"><button className="report-button" disabled={busy||s.capacity.value===1||s.planner.status==='thinking'} onClick={report}><ChefHat size={17}/>{s.capacity.value===1?'Cook report received':'Simulate cook report'}<ChevronRight size={14}/></button><button className="reset-button" disabled={busy} onClick={()=>void reset()}><RotateCcw size={14}/>Reset service</button></div></footer>}
 <div className="truth-line">Simulated kitchen inputs · Working model decisions & acknowledged actions · Synthetic time estimates</div>
 {about&&<div className="modal-backdrop" onClick={()=>setAbout(false)}><section className="about-modal" role="dialog" aria-modal="true" aria-label="About DineOS" onClick={e=>e.stopPropagation()}><button className="modal-close icon-button" aria-label="Close about" onClick={()=>setAbout(false)}><X size={19}/></button><img src="/favicon.svg" width="48" height="48" alt=""/><span className="eyebrow">DineOS</span><h2>From a guest’s words<br/>to the kitchen’s next move.</h2><p>DineOS keeps diner expectations, kitchen capacity and confirmed commitments in one shared service loop. The restaurant agent proposes a sequence, software checks it, and the kitchen simulator acknowledges it.</p><div className="about-loop"><span>Listen</span><ArrowRight size={13}/><span>Reconcile</span><ArrowRight size={13}/><span>Act</span><ArrowRight size={13}/><span>Verify</span></div><p className="quiet-note">Built with React, FastAPI, SQLite, OpenAI Realtime and {health?.planner_model??'gpt-5-mini'}. One seeded diner; simulated kitchen. No live POS/KDS, payments, allergy verification or measured restaurant outcomes. Demo view combines diner and coordinator screens for observers.</p><button className="primary" onClick={()=>setAbout(false)}>Back to service<ArrowRight size={15}/></button></section></div>}
 </div>;
}
function ClockIcon(){return <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>;}
