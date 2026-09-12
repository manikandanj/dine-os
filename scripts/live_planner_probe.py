"""Bounded real API evidence on an in-memory synthetic snapshot; no demo-state mutation."""
import asyncio, json, os
from backend.app import config
from backend.app.domain import seed,decorated,validate_sequence,now
from backend.app.planner import run_planner

async def main():
    s=seed();s['capacity'].update(value=1,source_id='cook_maya',source_kind='human_report',observed_at=now(),note='One grill slot available.')
    s['diner']['party_size']=1;s=decorated(s)
    proposal,tool,response_id=await run_planner(os.environ['OPENAI_API_KEY'],os.getenv('DINEOS_PLANNER_MODEL','gpt-5-mini'),s)
    timings=validate_sequence(s,proposal.sequence)
    print(json.dumps(dict(model=os.getenv('DINEOS_PLANNER_MODEL','gpt-5-mini'),tool=tool,response_id=response_id,proposal=proposal.model_dump(),validated_timings=timings),indent=2))
asyncio.run(main())
