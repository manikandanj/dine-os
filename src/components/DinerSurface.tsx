import {
  ArrowRight, Check, ChefHat, Clock3, Heart, RotateCcw, Sparkles, Utensils,
} from 'lucide-react';
import {useState,type ReactNode} from 'react';
import {intent,money,modifierName,type Snapshot,type MenuItem,type VoiceIntent} from '../types';
import {confirmation} from '../state';

const imageFor:Record<string,string>={
  biryani:'/dishes/chicken-biryani-memory.png',
  tandoori:'/dishes/tandoori-chicken.png',
  tikka_masala:'/dishes/chicken-tikka-masala.png',
  kadai_chicken:'/dishes/kadai-chicken.png',
};

const serverNotes:Record<string,string>={
  biryani:'Fragrant saffron rice, caramelized onion and the slow warmth you liked last time.',
  tandoori:'Smoky and bright, with a tangy yogurt marinade and a little char from the tandoor.',
  tikka_masala:'Charred chicken in a smooth tomato-cream sauce. Rich, gently smoky and made for tearing into with naan.',
  kadai_chicken:'A livelier cousin to tikka masala—tomato, peppers, toasted coriander and fresh ginger, finished quickly in the kadai.',
};

export function DishArt({item,small=false}:{item:MenuItem;small?:boolean}){
  return <div className={`dish-art ${small?'small':''}`}>
    <img src={imageFor[item.id]} alt={`${item.name}, illustrative dish photograph`}/>
    <span className="dish-sheen"/>
  </div>;
}

function Estimate({item}:{item:MenuItem}){
  return <span className={`estimate ${item.fits_preference?'fits':'slow'}`}>
    <Clock3 size={14}/>{item.estimate_minutes===null?'Checking timing':`${item.estimate_minutes} min`}
  </span>;
}

function Mira({children,tone='light'}:{children:ReactNode;tone?:'light'|'dark'}){
  return <div className={`mira-line ${tone}`}><span className="mira-avatar">M</span><div><strong>Mira</strong><p>{children}</p></div></div>;
}

function SpicePicker({selected,busy,onPick}:{selected:VoiceIntent['modifiers'];busy:boolean;onPick:(m:VoiceIntent['modifiers'][number])=>void}){
  return <div className="spice-picker" aria-label="Choose a spice level">
    <span>How should we make it?</span>
    <div>{(['mild','medium','spicy'] as const).map((level,index)=><button key={level} disabled={busy} className={selected.includes(level)?'active':''} onClick={()=>onPick(level)}><span className="pepper-meter">{'●'.repeat(index+1)}</span>{modifierName(level)}</button>)}</div>
  </div>;
}

export default function DinerSurface({s,busy,onIntent}:{s:Snapshot;busy:boolean;onIntent:(i:VoiceIntent)=>void}){
  const [finished,setFinished]=useState(false);
  const modifiers=s.surface.modifiers??[];
  const mode=s.surface.mode;
  const selected=s.menu.find(i=>i.id===s.surface.item_ids[0])??s.menu[0];
  const reviewed=s.offer?.status==='pending'&&mode==='review';
  const order=s.order;
  const choose=(item:MenuItem,mods:VoiceIntent['modifiers']=[])=>onIntent(intent('detail',{item_ids:[item.id],modifiers:mods}));
  const review=(item:MenuItem)=>onIntent(intent('review',{item_ids:[item.id],modifiers}));

  if(mode==='welcome'){
    const biryani=s.menu.find(i=>i.id==='biryani')??s.menu[0];
    return <section className="welcome-surface surface-enter">
      <div className="welcome-copy">
        <span className="welcome-kicker"><Sparkles size={15}/> Your table remembered</span>
        <h1>Hey Alex.<br/><em>Good to see you.</em></h1>
        <Mira tone="dark">You loved our chicken biryani last time. Want to go with your favorite—or try a different chicken dish today?</Mira>
        <div className="welcome-actions">
          <button className="tablet-primary" disabled={busy} onClick={()=>choose(biryani)}>My favorite again <ArrowRight size={16}/></button>
          <button className="tablet-ghost" disabled={busy} onClick={()=>onIntent(intent('compare',{item_ids:['tandoori','tikka_masala','kadai_chicken']}))}>Surprise me with something new</button>
        </div>
        <div className="memory-proof"><Heart size={13}/><span>Remembered from visit {s.diner.visits??8}</span><i/><span>Nothing ordered yet</span></div>
      </div>
      <div className="welcome-visual"><DishArt item={biryani}/><div className="favorite-stamp"><Heart size={15} fill="currentColor"/><span>Last time</span><strong>Your favorite</strong></div></div>
    </section>;
  }

  if(reviewed&&s.offer){
    const offer=s.offer;
    const canConfirm=selected.estimate_minutes===offer.terms.ready_in_minutes&&selected.fits_preference&&s.commitments_met===s.commitments_total;
    return <section className="review-card surface-enter" aria-label="Review your order">
      <Mira>I’ve got it just the way you asked. One quick look, then I’ll send it to the kitchen.</Mira>
      <div className="review-layout">
        <DishArt item={selected}/>
        <div className="review-copy">
          <span className="surface-kicker">Your order</span><h2>{offer.terms.name}</h2>
          <div className="review-pills"><span>{offer.terms.modifiers.map(modifierName).join('')}</span><span>1 serving</span></div>
          <div className="included-side"><Check size={15}/><div><strong>Included</strong><p>{selected.id==='kadai_chicken'?'Steamed basmati rice':selected.id==='tikka_masala'?'Tandoor naan':selected.id==='biryani'?'Cucumber raita':'Mint chutney & onion'}</p></div></div>
          <div className="review-total"><span><small>Ready in about</small><strong>{offer.terms.ready_in_minutes} min</strong></span><b>{money(offer.terms.price_cents)}</b></div>
          <button className="tablet-primary wide" disabled={busy||!canConfirm} onClick={()=>onIntent(intent('confirm',confirmation(offer)))}>Yes, send my order <ArrowRight size={17}/></button>
          <button className="review-change" disabled={busy} onClick={()=>choose(selected,offer.terms.modifiers as VoiceIntent['modifiers'])}>Make a change</button>
        </div>
      </div>
    </section>;
  }

  if(mode==='status'&&order){
    const done=order.status==='acknowledged';
    if(finished&&done)return <section className="farewell-card surface-enter"><span className="order-check"><Check size={32}/></span><h2>You’re all set, Alex.</h2><p>I’ll keep an eye on the kitchen. Your {order.terms.name.toLowerCase()} should be ready in about {order.terms.ready_in_minutes} minutes.</p><div className="mira-signoff"><span className="mira-avatar">M</span><span>Enjoy the moment.<strong>— Mira</strong></span></div></section>;
    return <section className={`order-card surface-enter ${done?'complete':''}`} aria-label="Order status">
      <div className="order-celebration"><span className="order-check">{done?<Check size={30}/>:<Clock3 size={28}/>}</span><span className="surface-kicker">{done?'Added to your order':'Sending to the kitchen'}</span><h2>{done?'Excellent choice.':'Just a moment…'}</h2><p>{done?'Your order is in. I’ll stay with the details from here.':s.surface.message}</p></div>
      <div className="order-summary"><DishArt item={selected} small/><div><span>Table 07</span><h3>{order.terms.name}</h3><p>{order.terms.modifiers.map(modifierName).join('')} · includes {selected.id==='kadai_chicken'?'basmati rice':'the house side'}</p><div><span className="estimate fits"><Clock3 size={14}/>{order.terms.ready_in_minutes} min</span><strong>{money(order.terms.price_cents)}</strong></div></div></div>
      {done?<div className="anything-else"><Mira>It comes with a side of rice. Would you like anything else?</Mira><div><button className="tablet-primary" onClick={()=>setFinished(true)}>No, that’s it for now</button><button className="tablet-ghost" onClick={()=>onIntent(intent('compare',{item_ids:['biryani','tandoori','kadai_chicken']}))}>Show me a little more</button></div></div>:<div className="kitchen-pending"><span/><p>Kitchen is acknowledging your order</p></div>}
    </section>;
  }

  if(mode==='clarify'||mode==='status')return <section className="clarify-card surface-enter"><span className="large-icon"><Utensils size={25}/></span><h2>Let’s get it right.</h2><Mira>{s.surface.message}</Mira><button className="tablet-primary" disabled={busy} onClick={()=>onIntent(intent('compare',{item_ids:['tandoori','tikka_masala','kadai_chicken']}))}>Show me your chicken picks <ArrowRight size={16}/></button></section>;

  if(mode==='compare'){
    const items=s.surface.item_ids.map(id=>s.menu.find(i=>i.id===id)!).filter(Boolean);
    const tradeoff=items.length===2&&items.some(item=>!item.fits_preference);
    return <section className="comparison surface-enter" aria-label="Compare your options">
      <div className="surface-heading"><Mira>{tradeoff?s.surface.message:'Absolutely. Here are three very different directions—all chicken, all worth knowing.'}</Mira><div><span className="surface-kicker">{tradeoff?'A thoughtful switch':'Mira recommends'}</span><h2>{tradeoff?'Same comfort. Much sooner.':'What sounds good today?'}</h2></div></div>
      <div className={`compare-grid count-${items.length}`}>{items.map(item=>{
        const recommended=item.id==='kadai_chicken';
        return <article className={`compare-card ${recommended?'recommended':''}`} key={item.id}>
          <DishArt item={item} small/>{recommended&&<span className="recommend-badge"><Sparkles size={12}/> Mira’s pick</span>}
          <div className="compare-body"><div className="compare-top"><span>{item.tags[0]}</span><Estimate item={item}/></div><h3>{item.name}</h3><p>{serverNotes[item.id]}</p><div className="compare-bottom"><strong>{money(item.price_cents)}</strong><button disabled={busy||item.stock===0} onClick={()=>choose(item)}>Tell me more <ArrowRight size={14}/></button></div></div>
        </article>;
      })}</div>
      <button className="quiet-back" onClick={()=>choose(s.menu.find(i=>i.id==='biryani')??s.menu[0])}><RotateCcw size={13}/> Maybe my usual after all</button>
    </section>;
  }

  return <section className="detail-surface surface-enter">
    <div className="detail-visual"><DishArt item={selected}/><div className="detail-floating"><span>{selected.tags[0]}</span><Estimate item={selected}/></div></div>
    <div className="detail-copy"><Mira>{s.surface.message==='A closer look.'?serverNotes[selected.id]:s.surface.message}</Mira><span className="surface-kicker">From our kitchen</span><h2>{selected.name}</h2><p className="dish-description">{selected.description}</p>
      <div className="detail-meta"><strong>{money(selected.price_cents)}</strong><span><ChefHat size={14}/>{selected.stock} portions available</span></div>
      {selected.fits_preference?<SpicePicker selected={modifiers} busy={busy} onPick={level=>choose(selected,[level])}/>:<div className="timing-callout"><Clock3 size={18}/><div><strong>Worth knowing</strong><p>This is about {selected.estimate_minutes} minutes today. Your usual lunch pace is closer to {s.diner.ready_within_minutes}.</p></div></div>}
      <button className="tablet-primary wide" disabled={busy||(selected.fits_preference&&modifiers.length!==1)} onClick={()=>review(selected)}>{selected.fits_preference?(modifiers.length?'Review my order':'Choose a spice level'):'Show me the quicker match'}<ArrowRight size={17}/></button>
      <p className="timing-note"><Clock3 size={12}/> Live food-ready estimate from the kitchen</p>
    </div>
  </section>;
}
