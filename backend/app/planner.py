"""A real model proposes; deterministic domain code remains the authority."""
import json
import httpx
from .models import PLANNER_TOOLS, PLANNER_TOOL_NAMES, PlannerProposal
from .domain import feasible_candidates, estimates

INSTRUCTIONS = '''You are DineOS, the restaurant-level preparation agent supervised by the coordinator.
Make exactly one narrow tool call. You receive authorized synthetic kitchen state. Preserve every confirmed
ready-by commitment and started job first. Never change a diner's confirmed meal. Tentative interest
reserves nothing. Propose a feasible sequence using every active ticket ID exactly once. The deterministic
candidate timings are authoritative; do not invent physical capacity, prices, inventory or estimates.
If the active sequence would miss a commitment but a supplied candidate meets all, choose that candidate.
Prefer the current sequence when all commitments are already met. Put started tickets first; do not
randomly rearrange otherwise equivalent tickets. When a diner's prospective grill choice misses their
ready-within preference, propose a stocked alternative that fits, preferring the mushroom bowl over soup
for a full meal. This is an offer, never consent. Explain the actual timing tradeoff concisely, without
claiming any requested action is already acknowledged. If inputs are stale/unknown or no sequence can
honor all commitments, use request_coordinator_update with a targeted question; preserve the active
sequence. For only an alternative, use propose_diner_alternative. Never invent an acknowledgment.
All durations are synthetic food-ready estimates relative to the paused scenario checkpoint, not a
prediction of time to leave. Speak in a warm, concise restaurant voice. Copy the state version exactly.'''

async def run_planner(api_key,model,state):
    candidates=feasible_candidates(state)
    authorized={k:state[k] for k in ['epoch','state_version','diner','capacity','tickets','active_sequence','timeline','order','paused','exceptions']}
    authorized['menu']=estimates(state)
    authorized['tentative_interest']=state['surface']['item_ids']
    authorized['feasible_candidates']=[{**c,'diner_options':estimates(state,c['sequence'])} for c in candidates[:12]]
    try:
        async with httpx.AsyncClient(timeout=40) as client:
            response=await client.post('https://api.openai.com/v1/responses',headers={'Authorization':f'Bearer {api_key}'},json=dict(model=model,instructions=INSTRUCTIONS,input=json.dumps(authorized),tools=PLANNER_TOOLS,tool_choice='required',parallel_tool_calls=False,store=False,reasoning={'effort':'low'},max_output_tokens=3000))
    except httpx.HTTPError as e:raise RuntimeError(f'Planner connection failed ({type(e).__name__}).') from e
    if not response.is_success:raise RuntimeError(f'Planner API returned HTTP {response.status_code}. Check server credentials or quota.')
    body=response.json();calls=[c for c in body.get('output',[]) if c.get('type')=='function_call' and c.get('name') in PLANNER_TOOL_NAMES]
    if len(calls)!=1:raise RuntimeError('Planner did not return exactly one supported typed proposal.')
    try:proposal=PlannerProposal.model_validate_json(calls[0]['arguments'])
    except (ValueError,KeyError) as e:raise RuntimeError('Planner returned an invalid proposal; no action was applied.') from e
    return proposal,calls[0]['name'],body['id']
