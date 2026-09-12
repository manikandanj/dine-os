from __future__ import annotations
import hashlib
import json
import sqlite3
import threading
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
from .domain import seed, now, decorated, estimates, schedule, validate_sequence, capacity_fresh
from .models import Command, VoiceIntent, Report, Pause, Override, AckMode, Ack, Progress, Empty, Generation

class Conflict(ValueError): pass

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

class Repository:
    def __init__(self,path):
        self.path=str(path); Path(path).parent.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock()
        with self.connect() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY, epoch TEXT NOT NULL, version INTEGER NOT NULL, ui INTEGER NOT NULL, cancelled INTEGER NOT NULL);
            ''')
            c.execute('INSERT OR IGNORE INTO state VALUES(1,?)',(json.dumps(seed()),))
    def connect(self):
        c=sqlite3.connect(self.path,timeout=10); c.row_factory=sqlite3.Row; return c
    def read(self,c): return json.loads(c.execute('SELECT body FROM state WHERE id=1').fetchone()['body'])
    def save(self,c,s): c.execute('UPDATE state SET body=? WHERE id=1',(json.dumps(s),))
    def snapshot(self):
        with self.connect() as c: return decorated(self.read(c))
    def event(self,s,kind,message,source='dineos',source_kind='recorded',simulated=False,**extra):
        s['events'].append(dict(id=uuid4().hex,kind=kind,message=message,source_id=source,source_kind=source_kind,simulated=simulated,observed_at=now(),state_version=s['state_version'],**extra))
        s['events']=s['events'][-100:]
    def bump(self,s,operational=True,ui=False):
        s['revision']+=1
        if operational:s['state_version']+=1
        if ui:s['ui_revision']+=1
    def invalidate(self,s):
        if s['offer'] and s['offer']['status']=='pending':
            s['offer']['status']='invalidated'
            self.event(s,'offer_invalidated','Terms changed. Please review a fresh offer.')
    def replay(self,c,id,identity):
        row=c.execute('SELECT * FROM commands WHERE id=?',(id,)).fetchone()
        if row:
            if row['identity']!=identity: raise Conflict('This command ID already belongs to a different request.')
            return json.loads(row['result'])
    def remember(self,c,id,identity,result):
        c.execute('INSERT INTO commands VALUES(?,?,?)',(id,identity,json.dumps(result)))
    def generation(self,g:Generation):
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE'); identity=digest(g.model_dump()); old=self.replay(c,g.command_id,identity)
            if old:return old
            s=self.read(c)
            if g.epoch!=s['epoch']: raise Conflict('Voice session belongs to a previous reset.')
            existing=c.execute('SELECT * FROM generations WHERE id=?',(g.response_id,)).fetchone()
            if existing:
                if g.cancelled:c.execute('UPDATE generations SET cancelled=1 WHERE id=?',(g.response_id,))
                elif existing['cancelled']:raise Conflict('Response was already interrupted.')
                elif existing['version']!=g.expected_state_version or existing['ui']!=g.expected_ui_revision:raise Conflict('Response binding cannot change.')
            else:
                if not g.cancelled and (s['state_version']!=g.expected_state_version or s['ui_revision']!=g.expected_ui_revision):raise Conflict('Voice response observed stale state. Refresh context.')
                c.execute('INSERT INTO generations VALUES(?,?,?,?,?)',(g.response_id,g.epoch,g.expected_state_version,g.expected_ui_revision,int(g.cancelled)))
            result={'ok':True};self.remember(c,g.command_id,identity,result);return result
    def command(self,cmd:Command):
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE'); identity=digest(cmd.model_dump()); old=self.replay(c,cmd.command_id,identity)
            if old:return old
            s=self.read(c)
            if cmd.epoch!=s['epoch'] or cmd.expected_state_version!=s['state_version']:raise Conflict('Service changed. Refresh and review the latest terms; this command was not applied.')
            if cmd.source in ('diner','realtime') and cmd.kind!='intent':raise Conflict('Diner tools cannot operate coordinator controls.')
            if cmd.source=='realtime':
                g=c.execute('SELECT * FROM generations WHERE id=?',(cmd.response_id,)).fetchone()
                if not g or g['cancelled'] or g['epoch']!=s['epoch'] or g['version']!=cmd.expected_state_version or g['ui']!=cmd.expected_ui_revision:
                    raise Conflict('Late or unbound voice tool rejected. Use the latest response generation.')
            payloads={'intent':VoiceIntent,'report':Report,'pause':Pause,'override':Override,'ack_mode':AckMode,'ack':Ack,'progress':Progress,'reset':Empty,'replan':Empty}
            p=payloads[cmd.kind].model_validate(cmd.payload)
            if cmd.kind=='intent':
                if cmd.expected_ui_revision!=s['ui_revision']:raise Conflict('The diner surface changed. Review the current selection.')
                self.intent(s,p,cmd.source)
            elif cmd.kind=='report':
                try: stamp=datetime.fromisoformat(p.observed_at.replace('Z','+00:00'))
                except ValueError:raise ValueError('Report timestamp must be ISO 8601.')
                if stamp.tzinfo is None:raise ValueError('Report timestamp must include its timezone.')
                if (stamp-datetime.now(timezone.utc)).total_seconds()>30:raise ValueError('Report timestamp cannot be in the future.')
                previous=datetime.fromisoformat(s['capacity']['observed_at'])
                if stamp<previous:raise Conflict('An older report cannot replace a newer observation.')
                self.bump(s);self.invalidate(s)
                s['capacity']=dict(value=p.capacity,**p.model_dump(exclude={'capacity'}),fresh=True)
                s['decision']=None
                self.event(s,'cook_report',p.note,p.source_id,p.source_kind,True)
                self.refresh_exceptions(s)
            elif cmd.kind=='pause':
                self.bump(s);s['paused']=p.paused;self.invalidate(s)
                self.event(s,'autonomy_paused' if p.paused else 'autonomy_resumed','Autonomy paused by coordinator.' if p.paused else 'Autonomy resumed.','coordinator')
            elif cmd.kind=='override':
                if any(a['status']=='requested' and a['kind']=='sequence' for a in s['actions']):raise Conflict('Resolve the outstanding sequence acknowledgment first.')
                timeline=validate_sequence(s,p.sequence)
                self.bump(s); self.invalidate(s)
                self.request_action(s,'sequence',sequence=p.sequence,rationale=p.reason,actor='coordinator',timeline=timeline)
            elif cmd.kind=='ack_mode':
                self.bump(s);s['ack_mode']=p.mode
                self.event(s,'simulator_control',f'Acknowledgment mode: {p.mode}','simulator','recorded',True)
            elif cmd.kind=='ack':
                self.acknowledge(s,p.action_id,p.success)
            elif cmd.kind=='progress':
                t=next((t for t in s['tickets'] if t['id']==p.ticket_id),None)
                if not t:raise ValueError('Unknown ticket.')
                if (t['status'],p.status) not in [('queued','started'),('started','ready')]:raise Conflict('Only queued → started → ready transitions are permitted.')
                if p.status=='started':
                    timeline=schedule(s); row=next(x for x in timeline if x['ticket_id']==t['id'])
                    if row['start']!=0:raise Conflict('This ticket is not the next work for its station.')
                self.bump(s);self.invalidate(s);t['status']=p.status;t['source_id']='kitchen_simulator';t['observed_at']=now()
                if p.status=='ready':s['active_sequence']=[i for i in s['active_sequence'] if i!=t['id']]
                if s['order'] and s['order']['ticket_id']==t['id']:s['order']['preparation_status']=p.status
                self.event(s,'ticket_'+p.status,f'Ticket {t["id"]}: {p.status}.','kitchen_simulator','recorded',True)
                self.refresh_exceptions(s)
            elif cmd.kind=='reset':
                s=seed(s['state_version']+1,s['revision']+1)
                c.execute('UPDATE generations SET cancelled=1')
                self.event(s,'reset','Fresh service seeded. Old offers, actions and voice generations invalidated.','simulator','recorded',True)
            elif cmd.kind=='replan':
                self.bump(s,False)
                self.event(s,'replan_requested','Coordinator requested a fresh decision.','coordinator')
            self.save(c,s); result=decorated(s);self.remember(c,cmd.command_id,identity,result)
            return result

    def intent(self,s,p,source):
        mode=p.action
        if p.party_size is not None and p.party_size!=1:
            self.bump(s,False,True);s['surface']=dict(mode='clarify',item_ids=[],message='This demo supports one diner. A server can help with a larger party.');return
        if mode=='confirm':
            offer=s['offer']
            if not offer or offer['status']!='pending' or (p.offer_id,p.offer_revision,p.terms_hash)!=(offer['id'],offer['revision'],offer['terms_hash']):raise Conflict('No matching active offer. Review the exact dish, modifiers, price and timing again.')
            if offer['state_version']!=s['state_version']:raise Conflict('The kitchen changed after this offer. Please review again.')
            if s['order']:raise Conflict('This diner already has an order. Changes require staff assistance; the existing meal is preserved.')
            item=next(i for i in s['menu'] if i['id']==offer['terms']['item_id'])
            if item['stock']<1:raise Conflict('The last portion has been taken. Please choose an alternative.')
            current=next(i for i in estimates(s) if i['id']==item['id'])
            if current['estimate_minutes']!=offer['terms']['ready_in_minutes'] or not current['fits_preference']:raise Conflict('The reviewed timing is no longer feasible. Please review a new offer.')
            if not all(x['on_time'] for x in schedule(s)):raise Conflict('Existing commitments need a coordinator decision before accepting this order.')
            self.bump(s,True,True); item['stock']-=1;offer['status']='confirmed'
            ticket=dict(id='D',table='07',name=item['name'],item_id=item['id'],station=item['station'],minutes=item['minutes'],ready_by=offer['terms']['ready_in_minutes'],status='queued',source_kind='recorded',source_id='diner_confirmation',observed_at=now(),simulated=True)
            action=self.request_action(s,'order',ticket=ticket,terms=offer['terms'],actor='diner')
            s['order']=dict(ticket_id='D',action_id=action['id'],status='requested',preparation_status='queued',terms=offer['terms'],confirmed_at=now())
            s['surface']=dict(mode='status',item_ids=[item['id']],message='Your choice is confirmed. Waiting for the kitchen acknowledgment.')
            self.event(s,'diner_confirmed',f'Alex confirmed {item["name"]}; stock and preparation time allocated.',source)
            return
        if mode=='decline':
            self.bump(s,False,True);self.invalidate(s)
            if s['order']:
                message='Your confirmed meal is unchanged. The coordinator can help with alternatives.'
            else:message='No order placed. Your choice stays yours; the coordinator can help.'
            s['surface']=dict(mode='clarify',item_ids=[],message=message)
            s['exceptions'].append(dict(id='diner_declined',message='Diner declined the proposed alternative. Follow up with Alex.',source_kind='recorded'))
            self.event(s,'alternative_declined',message,source);return
        self.bump(s,False,True)
        if mode not in ('status',):self.invalidate(s)
        if p.party_size==1 and s['diner']['party_size']!=1:
            s['diner']['party_size']=1
        if p.ready_within_minutes is not None and p.ready_within_minutes!=s['diner']['ready_within_minutes']:
            if s['order']:raise Conflict('A new time preference cannot silently change the confirmed commitment. Ask the coordinator.')
            s['diner']['ready_within_minutes']=p.ready_within_minutes;s['state_version']+=1
        if mode=='review':
            if s['diner']['party_size']!=1:
                s['surface']=dict(mode='clarify',item_ids=p.item_ids,message='Just you today? Please confirm a party of one before reviewing your order.');return
            if s['order']:
                s['surface']=dict(mode='status',item_ids=[s['order']['terms']['item_id']],message='Your confirmed meal is unchanged. Ask the coordinator to change it.');return
            item=next(i for i in estimates(s) if i['id']==p.item_ids[0])
            if any(m not in item['modifiers'] for m in p.modifiers):raise ValueError('That modifier is not supported for this dish.')
            if item['stock']<1 or not item['fits_preference'] or not all(t['on_time'] for t in schedule(s)):
                s['surface']=dict(mode='compare',item_ids=[item['id'],'mushroom'] if item['id']!='mushroom' else ['mushroom','soup'],message='Let’s find something that fits. This choice cannot currently meet the reviewed timing or availability.');return
            s['offer_counter']+=1
            terms=dict(item_id=item['id'],name=item['name'],quantity=1,modifiers=p.modifiers,price_cents=item['price_cents'],ready_in_minutes=item['estimate_minutes'],ready_within_minutes=s['diner']['ready_within_minutes'],timing_basis='Synthetic estimate; food ready from the service checkpoint',party_size=1)
            s['offer']=dict(id='offer_'+uuid4().hex,revision=s['offer_counter'],terms=terms,terms_hash=digest(terms),state_version=s['state_version'],status='pending')
            s['surface']=dict(mode='review',item_ids=p.item_ids,message='A quick review, then it’s your call.')
            self.event(s,'offer_reviewed',f'Reviewing {item["name"]}. Nothing reserved yet.',source)
        elif mode=='status':s['surface']=dict(mode='status',item_ids=[],message='Here’s the latest from the kitchen.' if s['order'] else 'You haven’t placed an order yet.')
        elif mode=='clarify':s['surface']=dict(mode='clarify',item_ids=p.item_ids,message=p.question or 'Do you mean food ready, or time to leave?')
        elif mode=='preference':s['surface']=dict(mode='detail',item_ids=p.item_ids or ['chicken'],message='We’ll look for food ready within your preference. Estimates are based on the current kitchen plan.')
        else:s['surface']=dict(mode=mode,item_ids=p.item_ids,message='A closer look.' if mode=='detail' else 'Good choices, side by side.')

    def request_action(self,s,kind,**data):
        action=dict(id='act_'+uuid4().hex,kind=kind,status='requested',requested_at=now(),acknowledged_at=None,requested_state_version=s['state_version'],epoch=s['epoch'],**data)
        s['actions'].append(action)
        self.event(s,'action_requested','Preparation sequence sent to the kitchen.' if kind=='sequence' else 'Order sent to the kitchen.','dineos' if data.get('actor')!='coordinator' else 'coordinator')
        return action
    def acknowledge(self,s,action_id,success):
        a=next((a for a in s['actions'] if a['id']==action_id),None)
        if not a or a['status']!='requested':raise Conflict('Action is no longer awaiting acknowledgment.')
        failure=None
        if success:
            if a['requested_state_version']!=s['state_version']:failure='Kitchen state changed before acknowledgment. Replan required.'
            elif a['kind']=='sequence':
                try:validate_sequence(s,a['sequence'])
                except ValueError as e:failure=str(e)
            elif not all(t['on_time'] for t in schedule(s)):failure='The accepted commitment is no longer feasible; coordinator review required.'
        else:failure='Kitchen simulator rejected this request.'
        self.bump(s);self.invalidate(s)
        a['status']='failed' if failure else 'acknowledged';a['acknowledged_at']=now();a['failure']=failure
        if not failure:
            if a['kind']=='sequence':
                s['active_sequence']=a['sequence']
                if s['decision']:s['decision']['status']='acknowledged'
            else:
                s['tickets'].append(a['ticket']);s['active_sequence'].append(a['ticket']['id']);s['order']['status']='acknowledged'
                s['surface']=dict(mode='status',item_ids=[a['terms']['item_id']],message='You’re all set. The kitchen has acknowledged your order.')
        elif a['kind']=='order':
            next(i for i in s['menu'] if i['id']==a['ticket']['item_id'])['stock']+=1
            s['order']['status']='failed';s['surface']=dict(mode='status',item_ids=[a['terms']['item_id']],message='The kitchen could not acknowledge your order. Your allocation was released; the coordinator has been alerted.')
        if failure:s['exceptions'].append(dict(id=a['id'],message=failure,source_kind='recorded'))
        self.event(s,'action_'+a['status'],failure or ('New preparation sequence is active.' if a['kind']=='sequence' else 'Order acknowledged by the kitchen.'),'kitchen_simulator','recorded',True,action_id=a['id'])
        self.refresh_exceptions(s)
    def refresh_exceptions(self,s):
        s['exceptions']=[e for e in s['exceptions'] if not e['id'].startswith('commitment_') and e['id']!='capacity_unknown']
        if not capacity_fresh(s):s['exceptions'].append(dict(id='capacity_unknown',message='Current grill capacity is unknown. Please add a fresh coordinator report.',source_kind='unknown'))
        for t in schedule(s):
            if not t['on_time']:s['exceptions'].append(dict(id='commitment_'+t['ticket_id'],message=f'Ticket {t["ticket_id"]} cannot meet its +{t["ready_by"]} min commitment under the active plan.',source_kind='derived'))

    def planner_status(self,epoch,status,model,message,request_id=None):
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');s=self.read(c)
            if s['epoch']!=epoch:return
            self.bump(s,False);s['planner']=dict(status=status,model=model,message=message,request_id=request_id);self.save(c,s)
    def apply_plan(self,observed,proposal,tool_name,model,response_id):
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');s=self.read(c)
            if s['epoch']!=observed['epoch'] or s['state_version']!=observed['state_version'] or proposal.observed_state_version!=s['state_version']:raise Conflict('Planner result became stale. Reread and replan.')
            if s['paused']:raise Conflict('Autonomy is paused at the server boundary.')
            if any(a['kind']=='sequence' and a['status']=='requested' for a in s['actions']):raise Conflict('A sequence is already awaiting acknowledgment.')
            before=list(s['active_sequence']);is_sequence=tool_name=='propose_preparation_sequence'
            if is_sequence:timeline=validate_sequence(s,proposal.sequence)
            else:timeline=schedule(s)
            if proposal.alternative_item_id:
                item=next(i for i in estimates(s,proposal.sequence if is_sequence else None) if i['id']==proposal.alternative_item_id)
                if item['stock']<1 or not item['fits_preference']:raise ValueError('Planner alternative is unavailable or misses the diner preference.')
            self.bump(s,operational=is_sequence and proposal.sequence!=before)
            if is_sequence and proposal.sequence!=before:self.invalidate(s)
            s['decision']=dict(**proposal.model_dump(),tool=tool_name,model=model,response_id=response_id,before=before,after=proposal.sequence if is_sequence else before,timeline=timeline,status='requested' if is_sequence and proposal.sequence!=before else 'no_action',decided_at=now())
            self.event(s,'planner_validated',proposal.rationale,'restaurant_agent','derived',False,model=model,response_id=response_id)
            if is_sequence and proposal.sequence!=before:self.request_action(s,'sequence',sequence=proposal.sequence,rationale=proposal.rationale,actor='agent',timeline=timeline)
            if proposal.coordinator_question:
                s['exceptions'].append(dict(id='planner_'+response_id,message=proposal.coordinator_question,source_kind='derived'))
            # Do not replace a newer diner surface with a proposal from an old UI context.
            if proposal.alternative_item_id and not s['order'] and s['ui_revision']==observed['ui_revision']:
                self.invalidate(s);s['ui_revision']+=1
                selected=s['surface']['item_ids'][0] if s['surface']['item_ids'] else 'chicken'
                s['surface']=dict(mode='compare',item_ids=list(dict.fromkeys([selected,proposal.alternative_item_id])),message=proposal.diner_message)
            s['planner']=dict(status='complete',model=model,message='Decision validated',request_id=response_id)
            self.save(c,s);return decorated(s)
