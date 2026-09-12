"""Restaurant fixture and deterministic scheduling; all durations are synthetic.

The scenario clock is operator-stepped. Time 0 is the current service checkpoint;
ready_by numbers mean food ready, never departure from the restaurant.
"""
from datetime import datetime, timezone
from itertools import permutations
from uuid import uuid4


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def seed(version=0, revision=0):
    at=now()
    return dict(epoch=uuid4().hex, state_version=version, revision=revision, ui_revision=0,
        scenario_minute=0, seeded_at=at, paused=False, ack_mode='auto',
        diner=dict(name='Alex',table='07',seeded=True,party_size=1,ready_within_minutes=15,
            visits=8,last_order='Chicken biryani',usual_spice='medium',
            memory_note='Loved the biryani last visit and usually chooses medium spice.'),
        menu=[
            dict(id='biryani',name='Chicken biryani',description='Saffron basmati, tender chicken, caramelized onion and mint, served with cool cucumber raita.',price_cents=2600,station='pass',minutes=8,stock=5,tags=['Your last favorite','Aromatic'],modifiers=['mild','medium','spicy']),
            dict(id='tandoori',name='Tandoori chicken',description='Yogurt-marinated chicken, roasted over high heat with mint chutney, lemon and pickled onion.',price_cents=2400,station='grill',minutes=14,stock=6,tags=['Smoky & bright','From the tandoor'],modifiers=['mild','medium','spicy']),
            dict(id='tikka_masala',name='Chicken tikka masala',description='Charred chicken folded into a silky tomato, fenugreek and cream sauce, served with naan.',price_cents=2700,station='grill',minutes=36,stock=4,tags=['Rich & comforting','House classic'],modifiers=['mild','medium','spicy']),
            dict(id='kadai_chicken',name='Kadai chicken',description='Wok-tossed chicken, tomato, peppers, toasted coriander and ginger, with basmati rice.',price_cents=2500,station='pass',minutes=10,stock=7,tags=['Bold & lively','Mira’s quick pick'],modifiers=['mild','medium','spicy'])],
        capacity=dict(value=2,source_id='seed_station_record',source_kind='recorded',observed_at=at,simulated=True,note='Two tandoor positions available.',fresh=True),
        tickets=[
            dict(id='A',table='03',name='Lamb seekh kebab',item_id=None,station='grill',minutes=6,ready_by=18,status='queued',source_kind='recorded',source_id='seed_ticket_A',observed_at=at,simulated=True),
            dict(id='B',table='05',name='Paneer tikka',item_id=None,station='grill',minutes=4,ready_by=6,status='queued',source_kind='recorded',source_id='seed_ticket_B',observed_at=at,simulated=True),
            dict(id='C',table='02',name='Garlic naan',item_id=None,station='pass',minutes=2,ready_by=5,status='started',source_kind='recorded',source_id='seed_ticket_C',observed_at=at,simulated=True)],
        active_sequence=['A','B','C'], offer=None, offer_counter=0, order=None, actions=[],events=[],
        surface=dict(mode='welcome',item_ids=['biryani'],message='Welcome back. Your table remembers the good parts.'),
        decision=None, planner=dict(status='idle',model=None,request_id=None,message='Watching service'),exceptions=[])


def capacity_fresh(state):
    fact=state['capacity']
    try:
        stamp=datetime.fromisoformat(fact['observed_at'].replace('Z','+00:00'))
        age=(datetime.now(timezone.utc)-stamp).total_seconds()
        return fact['value'] is not None and fact['source_kind']!='unknown' and -30 <= age <= 7200
    except (ValueError, TypeError):
        return False


def schedule(state, sequence=None, extra=None):
    sequence=sequence if sequence is not None else state['active_sequence']
    tickets={t['id']:t for t in state['tickets'] if t['status'] != 'ready'}
    # Requested orders reserve their own time immediately, but are not active tickets.
    pending=[a['ticket'] for a in state['actions'] if a['kind']=='order' and a['status']=='requested']
    for t in pending: tickets[t['id']]=t
    if extra: tickets[extra['id']]=extra
    ids=[i for i in sequence if i in tickets]
    ids += [i for i in tickets if i not in ids]
    # Started work is immovable and occupies the first available slot.
    ids.sort(key=lambda i: tickets[i]['status']!='started')
    cap=state['capacity']['value'] if capacity_fresh(state) else 0
    # A capacity report cannot serialize work that has already started in parallel.
    if cap is not None and sum(t['station']=='grill' and t['status']=='started' for t in tickets.values())>cap:cap=0
    slots={'grill':[0]*(cap or 0),'pass':[0]}
    result=[]
    for i in ids:
        t=tickets[i]; lanes=slots[t['station']]
        if not lanes:
            result.append(dict(ticket_id=i,start=None,end=None,ready_by=t['ready_by'],on_time=False,station=t['station']))
            continue
        lane=min(range(len(lanes)),key=lambda x:lanes[x])
        start=lanes[lane]; end=start+t['minutes']; lanes[lane]=end
        result.append(dict(ticket_id=i,start=start,end=end,ready_by=t['ready_by'],on_time=end<=t['ready_by'],station=t['station']))
    return result


def feasible_candidates(state):
    ids=[t['id'] for t in state['tickets'] if t['status']!='ready']
    # A bounded one-diner fixture, at most four active tickets.
    candidates=[]
    for order in permutations(ids):
        timeline=schedule(state,list(order))
        if all(t['on_time'] for t in timeline):
            candidates.append(dict(sequence=list(order),timings=timeline))
    return candidates


def validate_sequence(state, sequence):
    ids=[t['id'] for t in state['tickets'] if t['status']!='ready']
    if len(sequence)!=len(ids) or set(sequence)!=set(ids):
        raise ValueError('A sequence must include every active confirmed ticket exactly once.')
    if not capacity_fresh(state):
        raise ValueError('Ask the coordinator for a current grill-capacity report.')
    timeline=schedule(state,sequence)
    if not all(t['on_time'] for t in timeline):
        raise ValueError('This sequence breaks a confirmed ready-by commitment. Escalate the exception.')
    return timeline


def estimates(state, sequence=None):
    result=[]
    for item in state['menu']:
        t=dict(id='prospective',station=item['station'],minutes=item['minutes'],ready_by=state['diner']['ready_within_minutes'],status='queued')
        timing=next(t for t in schedule(state,sequence,extra=t) if t['ticket_id']=='prospective')
        result.append({**item,'estimate_minutes':timing['end'],'fits_preference':timing['on_time'],'estimate_source':'synthetic / derived'})
    return result


def decorated(state):
    import copy
    out=copy.deepcopy(state)
    out['capacity']['fresh']=capacity_fresh(state)
    out['menu']=estimates(state)
    out['timeline']=schedule(state)
    out['commitments_met']=sum(t['on_time'] for t in out['timeline'])
    out['commitments_total']=len(out['timeline'])
    out['events']=out['events'][-35:]
    return out
