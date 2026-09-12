import {useCallback,useEffect,useRef,useState} from 'react';
import {
  Activity,ArrowRight,AudioLines,ChefHat,ChevronRight,Eye,Info,
  Mic,RotateCcw,Sparkles,Square,Utensils,WifiOff,X,
} from 'lucide-react';
import {ApiError,getHealth,getSnapshot,sendCommand,generation} from './api';
import {acceptSnapshot,commandFor,uid} from './state';
import {intent,type Snapshot,type VoiceIntent,type Health,type Binding,type Command} from './types';
import {RealtimeVoiceClient,type VoiceStatus} from './realtime';
import DinerSurface from './components/DinerSurface';
import KitchenPanel from './components/KitchenPanel';

function context(s:Snapshot){
  return {epoch:s.epoch,state_version:s.state_version,ui_revision:s.ui_revision,diner:s.diner,menu:s.menu,capacity:s.capacity,offer:s.offer,order:s.order,surface:s.surface,decision:s.decision,planner:s.planner,exceptions:s.exceptions,actions:s.actions,active_sequence:s.active_sequence,timeline:s.timeline};
}

function BrandMark(){return <span className="brand-mark" aria-hidden="true"><span>t</span><i>&</i><span>s</span></span>;}

function AgentThought({s}:{s:Snapshot}){
  let label='Remember, then ask';
  let copy='Alex loved the biryani and usually orders medium. Mira can use that context, but won’t assume today’s choice.';
  if(s.surface.mode==='compare'&&s.surface.item_ids.length===3){label='Translate a vague craving';copy='“Something different” becomes three distinct directions: smoky, comforting, or bright and quick.';}
  if(s.surface.mode==='detail'){
    const item=s.menu.find(i=>i.id===s.surface.item_ids[0]);
    const hasSpice=!!s.surface.modifiers?.length;
    label=item?.fits_preference?(hasSpice?'Preference captured':'Explain, then personalize'):'Notice the tradeoff early';
    copy=item?.fits_preference?(hasSpice?`${s.surface.modifiers?.[0]} spice is explicit. Mira can now review the full order without making an assumption.`:`The dish fits Alex’s usual ${s.diner.ready_within_minutes}-minute lunch pace. Spice still needs an explicit choice.`):`This dish is tracking at ${item?.estimate_minutes} minutes. Mira can volunteer a faster, closely related option before it becomes a disappointment.`;
  }
  if(s.surface.mode==='compare'&&s.surface.item_ids.length===2){label='Offer a useful alternative';copy='Kadai chicken keeps the tomato, spice and comfort Alex liked, but the live kitchen can have it ready much sooner.';}
  if(s.surface.mode==='review'){label='Confirm the exact details';copy='Dish, spice, side, price and current estimate are visible together before anything is sent.';}
  if(s.order?.status==='requested'){label='Stay until it is real';copy='The request is visible, but Mira will not call it confirmed until the kitchen acknowledges it.';}
  if(s.order?.status==='acknowledged'){label='Close the loop';copy='The kitchen accepted the order. Mira can now offer the included side and remain available without upselling.';}
  return <div className="agent-thought"><div><Sparkles size={14}/><span>Mira is thinking</span></div><strong>{label}</strong><p>{copy}</p></div>;
}

export default function App(){
  const [s,setS]=useState<Snapshot|null>(null);
  const ref=useRef<Snapshot|null>(null);
  const [health,setHealth]=useState<Health|null>(null);
  const [demo,setDemo]=useState(true);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [connectionError,setConnectionError]=useState(false);
  const [about,setAbout]=useState(false);
  const [voiceStatus,setVoiceStatus]=useState<VoiceStatus>('idle');
  const [voiceDetail,setVoiceDetail]=useState('');
  const voice=useRef<RealtimeVoiceClient|null>(null);
  const bindings=useRef(new Map<string,Binding>());
  const connectionEpoch=useRef(0);

  const apply=useCallback((next:Snapshot,origin='poll')=>{
    setConnectionError(false);
    const old=ref.current;
    const accepted=acceptSnapshot(old,next);
    if(accepted===old)return;
    ref.current=accepted;
    setS(accepted);
    const last=next.actions.at(-1);
    const oldLast=old?.actions.at(-1);
    const newAck=!!last&&last.status!=='requested'&&(last.id!==oldLast?.id||last.status!==oldLast?.status);
    const changedEpoch=old&&old.epoch!==next.epoch;
    if(changedEpoch){voice.current?.disconnect();bindings.current.clear();setNotice('The opening scene is ready again.');}
    else voice.current?.syncContext(context(next),origin,origin!=='tool'&&newAck);
  },[]);

  useEffect(()=>{
    let stopped=false;
    let polling=false;
    let healthPoll=0;
    Promise.all([getSnapshot(),getHealth()]).then(([state,h])=>{if(!stopped){apply(state,'restore');setHealth(h);}}).catch(()=>{if(!stopped)setConnectionError(true);});
    const timer=window.setInterval(async()=>{
      if(stopped||polling)return;
      polling=true;
      try{
        const next=await getSnapshot();
        if(!stopped)apply(next);
        if(++healthPoll%10===0){const h=await getHealth();if(!stopped)setHealth(h);}
      }catch{if(!stopped)setConnectionError(true);}finally{polling=false;}
    },500);
    return()=>{stopped=true;window.clearInterval(timer);voice.current?.disconnect();};
  },[apply]);

  const execute=useCallback(async(cmd:Command,origin='click')=>{
    try{const next=await sendCommand(cmd);apply(next,origin);setNotice('');return next;}
    catch(e){
      if(e instanceof ApiError&&e.snapshot)apply(e.snapshot,'conflict');
      setNotice(e instanceof Error?e.message:'The request could not be applied.');
      throw e;
    }
  },[apply]);

  const run=async(kind:string,payload:object,source:Command['source']='coordinator')=>{
    if(!ref.current)return;
    setBusy(true);
    voice.current?.interrupt();
    try{return await execute(commandFor(ref.current,kind,payload,source));}
    catch{return undefined;}
    finally{setBusy(false);}
  };
  const sendIntent=(i:VoiceIntent)=>{void run('intent',i,'diner');};

  const connectVoice=async(initial?:Snapshot)=>{
    const state=initial??ref.current;
    if(!state)return;
    voice.current?.disconnect();
    bindings.current.clear();
    const connection=++connectionEpoch.current;
    const client=new RealtimeVoiceClient({
      onStatus:(status,detail)=>{if(connection!==connectionEpoch.current)return;setVoiceStatus(status);setVoiceDetail(detail??'');},
      onLatency:()=>undefined,
      onResponseStarted:(id)=>{
        const base=ref.current;
        if(!base)return;
        const binding:Binding={epoch:base.epoch,version:base.state_version,ui:base.ui_revision,cancelled:false,ready:Promise.resolve()};
        binding.ready=generation({command_id:uid('begin'),response_id:id,epoch:base.epoch,expected_state_version:base.state_version,expected_ui_revision:base.ui_revision,cancelled:false});
        void binding.ready.catch(()=>undefined);
        bindings.current.set(id,binding);
      },
      onInterruption:(id)=>{
        if(!id)return;
        const b=bindings.current.get(id);
        if(!b)return;
        b.cancelled=true;
        void generation({command_id:uid('cancel'),response_id:id,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,cancelled:true}).catch(()=>undefined);
      },
      onToolCall:async(args,callId,responseId)=>{
        const b=bindings.current.get(responseId);
        if(!b)throw new Error('Voice response is unbound. Please repeat after reconnecting.');
        await b.ready;
        if(b.cancelled||connection!==connectionEpoch.current)throw new Error('Interrupted voice tool rejected.');
        const cmd:Command={command_id:`voice_${callId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)}`,epoch:b.epoch,expected_state_version:b.version,expected_ui_revision:b.ui,kind:'intent',source:'realtime',response_id:responseId,payload:args};
        const result=await execute(cmd,'tool');
        return {ok:true,accepted_result:context(result)};
      },
    });
    voice.current=client;
    try{await client.connect(context(state));}
    catch(e){client.disconnect();if(connection===connectionEpoch.current){setVoiceStatus('error');setVoiceDetail(e instanceof Error?e.message:'Voice connection failed.');}}
  };

  const reset=async()=>{
    const wasActive=!['idle','disconnected','error'].includes(voiceStatus);
    voice.current?.disconnect();
    connectionEpoch.current++;
    const next=await run('reset',{});
    if(next&&wasActive)await connectVoice(next);
  };
  const active=!['idle','disconnected','error'].includes(voiceStatus);
  const simulateRush=()=>void run('report',{capacity:1,source_id:'cook_maya',source_kind:'human_report',observed_at:new Date().toISOString(),simulated:true,note:'Maya reports one tandoor position is unavailable during the rush.'});

  if(!s)return <div className="loading-shell"><BrandMark/><h1>Tinker & Spice</h1><p>{connectionError?'Start the backend on port 8001. We’ll reconnect automatically.':'Setting Alex’s table…'}</p></div>;

  return <div className={`app ${demo?'demo-view':'service-view'}`}>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Tinker and Spice home"><BrandMark/><span><strong>Tinker & Spice</strong><small>Context-aware dining</small></span></a>
      <div className="top-actions">
        <div className="view-switch" aria-label="View mode"><button className={!demo?'active':''} onClick={()=>setDemo(false)}>Guest only</button><button className={demo?'active':''} onClick={()=>setDemo(true)}>Demo view</button></div>
        <button className="icon-button" aria-label="About this demo" onClick={()=>setAbout(true)}><Info size={18}/></button>
        <button className="icon-button quiet-reset" aria-label="Restart demo" title="Restart demo" disabled={busy} onClick={()=>void reset()}><RotateCcw size={16}/></button>
      </div>
    </header>

    <main className="demo-shell">
      <section className="tablet-zone">
        {demo&&<div className="screen-label"><span><Eye size={14}/> Diner tablet</span><small>What Alex sees</small></div>}
        <div className="tablet-frame">
          <span className="tablet-camera"/>
          <div className="tablet-screen">
            <header className="tablet-header"><div><BrandMark/><span><strong>Tinker & Spice</strong><small>Modern Indian kitchen</small></span></div><div className="host-presence"><span className="mira-avatar">M</span><span><strong>Mira</strong><small><i/> Your host is here</small></span></div><span className="table-number"><Utensils size={13}/> 07</span></header>
            <div className="tablet-content"><DinerSurface key={s.epoch} s={s} busy={busy} onIntent={sendIntent}/></div>
            <div className={`voice-dock ${active?'active':''}`}>
              <div className={`voice-orb ${voiceStatus}`}><AudioLines size={21}/></div>
              <div className="voice-copy" role="status"><strong>{voiceStatus==='listening'?'I’m listening…':voiceStatus==='responding'?'Mira is with you…':voiceStatus==='connected'?'Mira is ready.':active?'Connecting to Mira…':'Talk naturally with Mira'}</strong><p>{voiceDetail||(voiceStatus==='responding'?'You can interrupt or change your mind anytime.':active?'Ask about a dish or say what sounds good.':'Try: “I’d like to try something different.”')}</p></div>
              {active?<button className="voice-button end" onClick={()=>{connectionEpoch.current++;voice.current?.disconnect();setVoiceStatus('disconnected');}}><Square size={12}/> End</button>:<button className="voice-button" disabled={!health?.openai_key_configured} onClick={()=>void connectVoice()}><Mic size={16}/>{voiceStatus==='error'||voiceStatus==='disconnected'?'Reconnect':'Talk with Mira'}</button>}
            </div>
            {notice&&<div className="notice" role="status"><Info size={14}/><span>{notice}</span><button aria-label="Dismiss" onClick={()=>setNotice('')}><X size={13}/></button></div>}
            {connectionError&&<div className="notice error" role="alert"><WifiOff size={14}/> Connection interrupted. Restoring the table…</div>}
          </div>
        </div>
      </section>

      {demo&&<aside className="context-rail" aria-label="Live restaurant context">
        <div className="rail-heading"><span><Activity size={14}/> Live restaurant context</span><small>Not visible to the diner</small></div>
        <section className="profile-card">
          <div className="profile-top"><div className="profile-avatar">A</div><div><span>Returning guest</span><h2>Alex Morgan</h2><p>Table 07 · Visit {s.diner.visits??8}</p></div><span className="profile-live">Recognized</span></div>
          <div className="profile-memory"><img src="/dishes/chicken-biryani-memory.png" alt="Alex's previous chicken biryani"/><div><span>Last time</span><strong>{s.diner.last_order??'Chicken biryani'}</strong><p>“Loved it” · {s.diner.usual_spice??'medium'} spice</p></div></div>
          <div className="profile-tags"><span>Prefers ≤ {s.diner.ready_within_minutes} min</span><span>Usually medium</span><span>Allergies not verified</span></div>
        </section>
        <AgentThought s={s}/>
        <KitchenPanel s={s} busy={busy} onCommand={(kind,payload)=>void run(kind,payload)}/>
        <div className="demo-cue"><div><ChefHat size={15}/><span><strong>Demo cue</strong><small>Show how a kitchen change reaches Mira.</small></span></div><button disabled={busy||s.capacity.value===1||s.planner.status==='thinking'} onClick={simulateRush}>{s.capacity.value===1?'Rush is active':'Simulate a rush'}<ChevronRight size={13}/></button></div>
      </aside>}
    </main>

    <footer className="truth-line"><span>Live model + deterministic restaurant state</span><i/>Synthetic timing and kitchen inputs for demonstration<i/>No payment or allergy verification</footer>

    {about&&<div className="modal-backdrop" onClick={()=>setAbout(false)}><section className="about-modal" role="dialog" aria-modal="true" aria-label="About Tinker and Spice" onClick={e=>e.stopPropagation()}><button className="modal-close icon-button" aria-label="Close" onClick={()=>setAbout(false)}><X size={19}/></button><BrandMark/><span className="eyebrow">Tinker & Spice</span><h2>A server who can feel the whole restaurant.</h2><p>Mira remembers Alex’s preferences, sees the live kitchen and changes the diner’s screen as the conversation moves—from memory, to discovery, to a realistic timing tradeoff, to an acknowledged order.</p><div className="about-loop"><span>Remember</span><ArrowRight size={13}/><span>Notice</span><ArrowRight size={13}/><span>Recommend</span><ArrowRight size={13}/><span>Follow through</span></div><p className="quiet-note">This hackathon demo uses seeded guest and kitchen data, synthetic food-ready estimates, OpenAI Realtime voice and a server-side planning agent. It does not connect to a live POS, KDS or payment system.</p><button className="tablet-primary" onClick={()=>setAbout(false)}>Back to Alex’s table <ArrowRight size={15}/></button></section></div>}
  </div>;
}
