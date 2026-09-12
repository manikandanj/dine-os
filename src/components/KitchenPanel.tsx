import {Activity,AlertCircle,Check,CheckCircle2,ChevronDown,Clock3,Flame,Pause,Play,RefreshCw,ShieldCheck,SlidersHorizontal} from 'lucide-react';
import {useState} from 'react';
import type {Snapshot} from '../types';

const time=(at:string)=>new Date(at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});

export default function KitchenPanel({s,busy,onCommand}:{s:Snapshot;busy:boolean;onCommand:(kind:string,payload:object)=>void}){
  const [capacity,setCapacity]=useState('2');
  const [reason,setReason]=useState('Tandoor checked; both positions available.');
  const [override,setOverride]=useState('');
  const pending=s.actions.filter(a=>a.status==='requested');
  const thinking=s.planner.status==='thinking';
  const latest=s.actions.at(-1);
  const kadai=s.menu.find(i=>i.id==='kadai_chicken');
  const tikka=s.menu.find(i=>i.id==='tikka_masala');
  const alexKadai=s.order?.terms.item_id==='kadai_chicken'?s.order.terms.ready_in_minutes:null;

  return <section className="kitchen-panel" aria-label="Kitchen view">
    <div className="kitchen-header"><div><span>Live kitchen</span><h2>The room right now</h2></div><span className={`live-dot ${s.paused?'paused':''}`}><i/>{s.paused?'Paused':'Live'}</span></div>
    <div className="kitchen-signal-grid">
      <div className="signal fast"><span>{alexKadai?'Alex · Kadai':'Kadai chicken'}</span><strong>{alexKadai??kadai?.estimate_minutes??'—'} min</strong><small>{alexKadai?'Promised time':'Range & pass'}</small></div>
      <div className="signal slow"><span>Tikka masala</span><strong>{tikka?.estimate_minutes??'—'} min</strong><small>Tandoor queue</small></div>
    </div>
    <div className={`capacity-line ${s.capacity.value!==2?'constrained':''}`}><Flame size={16}/><div><strong>{s.capacity.value===2?'2 tandoor positions open':`${s.capacity.value??0} tandoor position open`}</strong><span>{s.capacity.note}</span></div><small>{time(s.capacity.observed_at)}</small></div>
    <div className="ticket-section"><div className="section-label"><span>Active tables</span><span className={s.commitments_met===s.commitments_total?'good':'amber'}>{s.commitments_met}/{s.commitments_total} on time</span></div><div className="ticket-list">{s.tickets.map(t=>{const timing=s.timeline.find(x=>x.ticket_id===t.id);return <div className="ticket-row" key={t.id}><span className={`ticket-id ${t.status}`}>{t.table}</span><div><strong>{t.name}</strong><small>Table {t.table} · {t.status}</small></div><span className="ticket-time">{t.status==='ready'?'Ready':`${timing?.end??'—'} min`}</span>{t.status==='ready'||timing?.on_time?<CheckCircle2 size={14}/>:<AlertCircle size={14}/>}</div>;})}</div></div>
    <div className={`agent-status ${thinking?'thinking':''}`}><span>{thinking?<RefreshCw className="spinning" size={15}/>:s.paused?<Pause size={15}/>:<Activity size={15}/>}</span><div><strong>{thinking?'Rebalancing the room…':s.paused?'Agent paused':'All commitments watched'}</strong><small>{s.decision?.rationale??'Mira receives kitchen changes in real time.'}</small></div><span>v{s.state_version}</span></div>
    {latest&&<div className={`action-ack ${latest.status}`}><span>{latest.status==='acknowledged'?<Check size={15}/>:latest.status==='failed'?<AlertCircle size={15}/>:<Clock3 size={15}/>}</span><p>{latest.status==='acknowledged'?(latest.kind==='order'?'Order accepted by kitchen':'New sequence active'):latest.status==='failed'?'Kitchen request needs attention':'Waiting for kitchen acknowledgment'}</p></div>}
    {s.exceptions.length>0&&<details className="exceptions"><summary><AlertCircle size={14}/>{s.exceptions.length} exception{s.exceptions.length>1?'s':''}<ChevronDown size={13}/></summary>{s.exceptions.map(e=><p key={e.id}>{e.message}</p>)}</details>}
    <details className="operator-tools"><summary><SlidersHorizontal size={14}/> Operator tools<ChevronDown size={13}/></summary><div className="operator-body">
      <button className="operator-button" disabled={busy} onClick={()=>onCommand('pause',{paused:!s.paused})}>{s.paused?<Play size={13}/>:<Pause size={13}/>} {s.paused?'Resume agent':'Pause agent'}</button>
      <label>Tandoor capacity<select value={capacity} onChange={e=>setCapacity(e.target.value)}><option value="2">2 positions</option><option value="1">1 position</option><option value="0">0 positions</option><option value="unknown">Needs staff update</option></select></label>
      <label>Source note<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={240}/></label>
      <button className="operator-button wide" disabled={busy||!reason} onClick={()=>onCommand('report',{capacity:capacity==='unknown'?null:Number(capacity),source_id:'coordinator',source_kind:capacity==='unknown'?'unknown':'human_report',observed_at:new Date().toISOString(),simulated:true,note:reason})}>Apply kitchen update</button>
      <label>One-time sequence override<input placeholder={s.active_sequence.join(', ')} value={override} onChange={e=>setOverride(e.target.value)}/></label>
      <button className="operator-button wide" disabled={busy||!override} onClick={()=>onCommand('override',{sequence:override.split(',').map(v=>v.trim()).filter(Boolean),reason:'One-decision override by coordinator'})}><ShieldCheck size={13}/> Validate override</button>
      <label>Acknowledgment<select value={s.ack_mode} onChange={e=>onCommand('ack_mode',{mode:e.target.value})}><option value="auto">Automatic</option><option value="manual">Manual</option><option value="fail_next">Fail next</option></select></label>
      {pending.map(a=><div className="pending-controls" key={a.id}><span>{a.kind} request</span><button disabled={busy} onClick={()=>onCommand('ack',{action_id:a.id,success:true})}>Acknowledge</button><button disabled={busy} onClick={()=>onCommand('ack',{action_id:a.id,success:false})}>Fail</button></div>)}
    </div></details>
  </section>;
}
