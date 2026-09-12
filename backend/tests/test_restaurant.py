from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
import pytest
from fastapi.testclient import TestClient
from backend.app.domain import seed,decorated,schedule,validate_sequence,now
from backend.app.models import Command,VoiceIntent,PlannerProposal,Generation
from backend.app.repository import Repository,Conflict
from backend.app.main import create_app,realtime_session_config

def args(action='detail',**patch):
    return dict(action=action,item_ids=['chicken'] if action in ('detail','review') else [],modifiers=[],ready_within_minutes=None,party_size=None,offer_id=None,offer_revision=None,terms_hash=None,question=None,**{}) | patch

@pytest.fixture
def repo(tmp_path):return Repository(tmp_path/'test.sqlite3')

def cmd(repo,kind,payload=None,source='coordinator',**patch):
    from uuid import uuid4
    s=repo.snapshot()
    return Command(command_id='cmd_'+uuid4().hex,epoch=s['epoch'],expected_state_version=s['state_version'],expected_ui_revision=s['ui_revision'],kind=kind,source=source,payload=payload or {},**{}) .model_copy(update=patch)
def do(repo,kind,payload=None,**patch):return repo.command(cmd(repo,kind,payload,**patch))
def diner(repo,action='detail',**patch):return do(repo,'intent',args(action,**patch),source='diner')
def review(repo,item='chicken',**patch):
    diner(repo,'preference',party_size=1)
    return diner(repo,'review',item_ids=[item],**patch)['offer']
def confirmation(o):return args('confirm',offer_id=o['id'],offer_revision=o['revision'],terms_hash=o['terms_hash'])
def report(repo,capacity=1):return do(repo,'report',dict(capacity=capacity,source_id='cook_maya',source_kind='human_report',observed_at=now(),simulated=True,note='Grill capacity update'))
def plan(s,sequence=None,alternative='mushroom',question=None):return PlannerProposal(observed_state_version=s['state_version'],sequence=sequence or ['C','B','A'],rationale='Preserve started C and meet B’s +6 and A’s +18 commitments.',alternative_item_id=alternative,diner_message='Chicken is 16 minutes; the mushroom bowl is 8 minutes.',coordinator_question=question)
def apply_plan(repo,**kw):
    s=repo.snapshot();return repo.apply_plan(s,plan(s,**kw),'propose_preparation_sequence','test-double','synthetic_response')
def ack(repo,a,success=True):return do(repo,'ack',dict(action_id=a['id'],success=success),source='simulator')

def test_fixture_schedule_and_constraint_reconciliation():
    s=seed();assert all(t['on_time'] for t in schedule(s))
    s['capacity']['value']=1
    assert not next(t for t in schedule(s) if t['ticket_id']=='B')['on_time']
    timeline=validate_sequence(s,['C','B','A']);assert all(t['on_time'] for t in timeline)
    assert [t['end'] for t in timeline]==[2,4,10]
    with pytest.raises(ValueError):validate_sequence(s,['A','B','C'])
    with pytest.raises(ValueError):validate_sequence(s,['B','A'])

def test_views_interest_and_review_do_not_allocate_or_bump_operational_version(repo):
    before=repo.snapshot();diner(repo);diner(repo,'compare',item_ids=['chicken','mushroom']);review(repo)
    after=repo.snapshot();assert after['state_version']==before['state_version']
    assert after['active_sequence']==before['active_sequence'];assert after['menu'][0]['stock']==before['menu'][0]['stock']
    assert not after['actions'];assert after['ui_revision']>0

def test_exact_confirmation_allocates_then_acknowledges(repo):
    o=review(repo,modifiers=['sauce_on_side']);result=do(repo,'intent',confirmation(o),source='diner')
    assert result['order']['status']=='requested';assert len(result['tickets'])==3
    assert result['menu'][0]['stock']==5
    done=ack(repo,result['actions'][-1]);assert done['order']['status']=='acknowledged'
    assert len(done['tickets'])==4;assert done['order']['terms']==o['terms'];assert done['commitments_met']==4

def test_direct_or_modified_confirmation_rejected(repo):
    with pytest.raises(Conflict):diner(repo,'confirm',offer_id='fake',offer_revision=1,terms_hash='fake')
    o=review(repo)
    with pytest.raises(Conflict):diner(repo,'confirm',offer_id=o['id'],offer_revision=o['revision']+1,terms_hash=o['terms_hash'])
    with pytest.raises(Conflict):diner(repo,'confirm',offer_id=o['id'],offer_revision=o['revision'],terms_hash='changed_price')
    assert repo.snapshot()['order'] is None

def test_corrected_and_stale_offer_cannot_confirm(repo):
    o=review(repo);old=cmd(repo,'intent',confirmation(o),source='diner')
    diner(repo,'detail',item_ids=['mushroom'])
    with pytest.raises(Conflict):repo.command(old)
    with pytest.raises(Conflict):do(repo,'intent',confirmation(o),source='diner')
    o=review(repo);report(repo)
    with pytest.raises(Conflict):do(repo,'intent',confirmation(o),source='diner')

def test_duplicate_lost_response_retry_has_one_effect_and_persists(repo):
    o=review(repo);c=cmd(repo,'intent',confirmation(o),source='diner');first=repo.command(c)
    second=Repository(repo.path).command(c);assert second==first
    assert len(repo.snapshot()['actions'])==1
    with pytest.raises(Conflict):repo.command(c.model_copy(update={'expected_state_version':first['state_version']}))

def test_competing_confirmations_cannot_consume_last_bowl_twice(repo):
    o=review(repo,'mushroom');a=cmd(repo,'intent',confirmation(o),source='diner');b=cmd(repo,'intent',confirmation(o),source='diner')
    def attempt(c):
        try:return Repository(repo.path).command(c)
        except Conflict:return None
    with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,[a,b]))
    assert sum(r is not None for r in results)==1
    s=repo.snapshot();assert next(i['stock'] for i in s['menu'] if i['id']=='mushroom')==0;assert len(s['actions'])==1

def test_report_real_proposal_then_simulator_ack_loop(repo):
    diner(repo,'preference',party_size=1);report(repo);requested=apply_plan(repo)
    assert requested['active_sequence']==['A','B','C'];assert requested['actions'][-1]['status']=='requested'
    done=ack(repo,requested['actions'][-1]);assert done['active_sequence']==['C','B','A'];assert done['commitments_met']==3
    o=diner(repo,'review',item_ids=['mushroom'])['offer'];assert o['terms']['ready_in_minutes']==8
    result=do(repo,'intent',confirmation(o),source='diner');done=ack(repo,result['actions'][-1]);assert done['commitments_met']==4
    assert done['order']['terms']['price_cents']==2200

def test_failed_sequence_ack_never_activates(repo):
    report(repo);r=apply_plan(repo);failed=ack(repo,r['actions'][-1],False)
    assert failed['active_sequence']==['A','B','C'];assert failed['actions'][-1]['status']=='failed';assert failed['exceptions']

def test_failed_order_ack_releases_allocation_without_active_order(repo):
    o=review(repo,'mushroom');r=do(repo,'intent',confirmation(o),source='diner');failed=ack(repo,r['actions'][-1],False)
    assert failed['order']['status']=='failed';assert len(failed['tickets'])==3
    assert next(i['stock'] for i in failed['menu'] if i['id']=='mushroom')==1

def test_pause_and_guarded_one_decision_override(repo):
    report(repo);do(repo,'pause',{'paused':True})
    with pytest.raises(Conflict):apply_plan(repo)
    with pytest.raises(ValueError):do(repo,'override',dict(sequence=['A','B','C'],reason='unsafe'))
    r=do(repo,'override',dict(sequence=['C','B','A'],reason='Coordinator single decision'))
    done=ack(repo,r['actions'][-1]);assert done['paused'];assert done['active_sequence']==['C','B','A']

def test_stale_planner_and_ack_rejected(repo):
    report(repo);old=repo.snapshot();do(repo,'pause',{'paused':True})
    with pytest.raises(Conflict):repo.apply_plan(old,plan(old),'propose_preparation_sequence','test','old')
    do(repo,'pause',{'paused':False});r=apply_plan(repo);report(repo,2)
    failed=ack(repo,r['actions'][-1]);assert failed['actions'][-1]['status']=='failed';assert failed['active_sequence']==['A','B','C']

def test_unknown_capacity_and_impossible_commitments_escalate(repo):
    s=report(repo,0);assert s['exceptions']
    with pytest.raises(ValueError):apply_plan(repo)
    result=repo.apply_plan(s,plan(s,sequence=s['active_sequence'],alternative=None,question='Can a coordinator confirm the grill recovery time?'),'request_coordinator_update','test','escalate')
    assert not result['actions'];assert any('recovery' in e['message'] for e in result['exceptions'])

def test_stale_critical_fact_is_not_used():
    s=seed();s['capacity']['observed_at']=(datetime.now(timezone.utc)-timedelta(hours=3)).isoformat()
    assert not decorated(s)['capacity']['fresh']
    with pytest.raises(ValueError):validate_sequence(s,['C','B','A'])

def test_decline_does_not_change_confirmed_meal(repo):
    o=review(repo);r=do(repo,'intent',confirmation(o),source='diner');ack(repo,r['actions'][-1]);before=repo.snapshot()['order']
    after=diner(repo,'decline');assert after['order']==before;assert after['exceptions']

def test_interrupted_generation_rejected_on_server(repo):
    s=repo.snapshot();g=Generation(command_id='begin_1',response_id='resp_1',epoch=s['epoch'],expected_state_version=s['state_version'],expected_ui_revision=s['ui_revision'],cancelled=False)
    repo.generation(g);repo.generation(g.model_copy(update={'command_id':'cancel_1','cancelled':True}))
    with pytest.raises(Conflict):do(repo,'intent',args(),source='realtime',response_id='resp_1')
    assert repo.snapshot()['ui_revision']==0

def test_cancel_arriving_before_registration_still_blocks_generation(repo):
    s=repo.snapshot();g=Generation(command_id='cancel_early',response_id='resp_late',epoch=s['epoch'],expected_state_version=0,expected_ui_revision=0,cancelled=True)
    repo.generation(g)
    with pytest.raises(Conflict):repo.generation(g.model_copy(update={'command_id':'late_begin','cancelled':False}))

def test_reset_invalidates_delayed_tools_actions_and_old_offers(repo):
    o=review(repo);old=cmd(repo,'intent',confirmation(o),source='diner');before=repo.snapshot();fresh=do(repo,'reset')
    assert fresh['epoch']!=before['epoch'];assert fresh['revision']>before['revision'];assert not fresh['order'];assert fresh['offer'] is None
    with pytest.raises(Conflict):repo.command(old)

def test_diner_cannot_change_coordinator_constraints(repo):
    with pytest.raises(Conflict):do(repo,'pause',dict(paused=True),source='realtime')

def test_started_work_is_preserved_and_illegal_progress_rejected(repo):
    report(repo);r=apply_plan(repo);ack(repo,r['actions'][-1]);assert repo.snapshot()['tickets'][2]['status']=='started'
    with pytest.raises(Conflict):do(repo,'progress',dict(ticket_id='A',status='started'))
    do(repo,'progress',dict(ticket_id='B',status='started'))
    with pytest.raises(Conflict):do(repo,'progress',dict(ticket_id='A',status='ready'))

def test_api_config_and_reconnect_restore_authoritative_context(tmp_path):
    app=create_app(tmp_path/'api.sqlite3',api_key='',autostart=False)
    with TestClient(app) as client:
        assert client.get('/api/health').json()['openai_key_configured'] is False
        assert client.get('/api/voice/context').json()['menu'][0]['name']=='Lemon-herb chicken'
        s=client.get('/api/state').json();assert s['state_version']==0
        cfg=realtime_session_config('gpt-realtime-2.1','marin',s)
        assert 'terms_hash' in str(cfg['tools']);assert 'Alex' in cfg['instructions'];assert 'API_KEY' not in str(cfg)
        assert client.post('/api/realtime/calls',headers={'Content-Type':'application/sdp'},content='v=0').status_code==503
        assert client.post('/api/commands',headers={'Origin':'https://untrusted.example'},json={}).status_code==403
