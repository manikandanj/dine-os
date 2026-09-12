import asyncio
from uuid import uuid4
from .repository import Conflict
from .models import Command

class Engine:
    def __init__(self,repo,key,model,runner):
        self.repo=repo;self.key=key;self.model=model;self.runner=runner
        self.wake=asyncio.Event();self.needs_plan=False;self.stopped=False
    def request(self):
        self.needs_plan=True;self.wake.set()
    async def cycle(self):
        while not self.stopped:
            try:
                await asyncio.wait_for(self.wake.wait(),timeout=.5)
            except asyncio.TimeoutError:pass
            self.wake.clear()
            s=self.repo.snapshot()
            pending=next((a for a in s['actions'] if a['status']=='requested'),None)
            if pending and s['ack_mode']!='manual':
                await asyncio.sleep(.8)
                latest=self.repo.snapshot()
                if latest['epoch']!=s['epoch']:continue
                try:
                    self.repo.command(Command(command_id='autoack_'+pending['id'],epoch=latest['epoch'],expected_state_version=latest['state_version'],expected_ui_revision=latest['ui_revision'],kind='ack',source='simulator',payload={'action_id':pending['id'],'success':latest['ack_mode']!='fail_next'}))
                    if latest['ack_mode']=='fail_next':
                        latest=self.repo.snapshot()
                        self.repo.command(Command(command_id='consume_fail_'+pending['id'],epoch=latest['epoch'],expected_state_version=latest['state_version'],expected_ui_revision=latest['ui_revision'],kind='ack_mode',source='simulator',payload={'mode':'auto'}))
                    if pending['kind']=='order':self.needs_plan=True
                except Conflict:pass
                s=self.repo.snapshot()
            if not self.needs_plan:continue
            if any(a['status']=='requested' for a in s['actions']):continue
            self.needs_plan=False
            if s['paused']:
                self.repo.planner_status(s['epoch'],'paused',self.model,'Paused by coordinator');continue
            if not self.key:
                self.repo.planner_status(s['epoch'],'error',self.model,'OPENAI_API_KEY is not configured. Add it on the server; no model action was fabricated.');continue
            for attempt in range(3):
                s=self.repo.snapshot()
                if s['paused']:break
                self.repo.planner_status(s['epoch'],'thinking',self.model,'Reconciling commitments and capacity')
                try:
                    proposal,tool,response_id=await self.runner(self.key,self.model,s)
                    self.repo.apply_plan(s,proposal,tool,self.model,response_id)
                    break
                except Conflict as e:
                    latest=self.repo.snapshot()
                    if latest['epoch']!=s['epoch'] or latest['paused']:break
                    if attempt==2:self.repo.planner_status(s['epoch'],'error',self.model,str(e))
                except (RuntimeError,ValueError) as e:
                    self.repo.planner_status(s['epoch'],'error',self.model,str(e));break
