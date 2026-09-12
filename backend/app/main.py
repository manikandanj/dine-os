from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import ValidationError
from . import config
from .models import Command, Generation, REALTIME_TOOL
from .repository import Repository, Conflict
from .planner import run_planner
from .engine import Engine

VOICE_INSTRUCTIONS='''You are DineOS, a warm, concise host at a neighborhood restaurant. The recognized diner
Alex is a disclosed seeded profile, table 07. Ask "Just you today?" at the beginning if party size is unknown.
The demo supports one diner. Ask whether a time constraint means food ready or leaving; all available
estimates mean food ready from the current service checkpoint. Use short natural turns, typically 1–2
sentences. Never recite the whole menu or internal IDs. Speak English unless the diner chooses otherwise.
Call dineos_intent whenever they inspect a dish, compare choices, set a preference, ask to order, correct a
choice, decline or ask for status. Use the tool in the same turn as the visual explanation. The menu IDs
are chicken, mushroom, soup. Never infer UI or transaction success from your own prose.
An order request FIRST uses action=review. Read the returned exact dish, modifiers, price and timing,
then ask the diner to TAP the confirmation button. A review reserves nothing. Use action=confirm only
on an explicit later voice confirmation after a successful review, copying the exact offer_id, revision
and terms_hash from that offer; never guess these. When terms change, review again. No model-provided
Boolean counts as consent. You may not change an existing confirmed meal: ask the coordinator.
Return no raw transcript. Never invent menu facts, allergy safety, capacity, availability, prices, estimates,
confirmed orders, completion or acknowledgments. The tool returns authoritative context and accepted state.
Treat authoritative state updates as facts, not diner speech. A cook report and kitchen simulator are
simulated, and timing estimates are synthetic. Explain this briefly when relevant; do not repeatedly
recite technical caveats. If a kitchen event changes the options, acknowledge it briefly using current
numbers and ask which option the diner wants. Do not claim a new sequence/order is active until its
status is acknowledged. If a request is stale/rejected, use the returned latest snapshot and ask for
renewed review rather than silently reusing consent. For unavailable or unknown facts ask a targeted
question. An update is context, never authorization to order. No need to call a tool just to say hello.
'''

def voice_context(s):
    return {k:s[k] for k in ['epoch','state_version','ui_revision','diner','menu','capacity','offer','order','surface','planner','decision','exceptions','active_sequence','timeline','actions']}

def realtime_session_config(model,voice,state):
    return dict(type='realtime',model=model,instructions=VOICE_INSTRUCTIONS+'\nAuthoritative state:\n'+json.dumps(voice_context(state)),output_modalities=['audio'],audio={'input':{'turn_detection':{'type':'server_vad','create_response':True,'interrupt_response':True}},'output':{'voice':voice}},tools=[REALTIME_TOOL],tool_choice='auto')

def create_app(database_path=None,api_key=None,planner_runner=None,autostart=True):
    repo=Repository(database_path or os.getenv('DINEOS_SQLITE_PATH',str(config.ROOT/'backend/data/dineos.sqlite3')))
    key=api_key if api_key is not None else os.getenv('OPENAI_API_KEY','')
    model=os.getenv('DINEOS_PLANNER_MODEL','gpt-5-mini')
    realtime_model=os.getenv('DINEOS_REALTIME_MODEL','gpt-realtime-2.1')
    engine=Engine(repo,key,model,planner_runner or run_planner)
    @asynccontextmanager
    async def lifespan(app):
        task=asyncio.create_task(engine.cycle()) if autostart else None
        yield
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):await task
    app=FastAPI(title='DineOS',version='0.1.0',lifespan=lifespan)
    app.state.repo=repo;app.state.engine=engine
    origins=[os.getenv('DINEOS_ALLOWED_ORIGIN','http://127.0.0.1:5174'),'http://localhost:5174']
    app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=['GET','POST'],allow_headers=['Content-Type'])
    @app.middleware('http')
    async def origin_boundary(request,call_next):
        if request.method=='POST' and request.headers.get('origin') and request.headers['origin'] not in origins:
            return JSONResponse(status_code=403,content={'detail':'This local demo accepts commands only from its configured origin.'})
        return await call_next(request)
    @app.exception_handler(Conflict)
    async def conflict(request,exc):return JSONResponse(status_code=409,content={'detail':str(exc),'snapshot':repo.snapshot()})
    @app.exception_handler(ValueError)
    async def invalid(request,exc):return JSONResponse(status_code=422,content={'detail':str(exc)})
    @app.get('/api/health')
    def health():return dict(status='ok',product='DineOS',openai_key_configured=bool(key),planner_model=model,realtime_model=realtime_model)
    @app.get('/api/state')
    def state():return repo.snapshot()
    @app.get('/api/voice/context')
    def context():return voice_context(repo.snapshot())
    @app.post('/api/voice/generations')
    def generation(g:Generation):return repo.generation(g)
    @app.post('/api/commands')
    def command(cmd:Command):
        result=repo.command(cmd)
        if cmd.kind in ('report','replan','progress') or cmd.kind=='pause' and not result['paused'] or cmd.kind=='intent' and cmd.payload.get('action')=='confirm':engine.request()
        if cmd.kind=='reset':engine.needs_plan=False
        return result
    @app.post('/api/realtime/calls',response_class=PlainTextResponse)
    async def realtime(request:Request):
        if not key:raise HTTPException(503,'OPENAI_API_KEY is not configured on the server.')
        if 'application/sdp' not in request.headers.get('content-type',''):raise HTTPException(415,'Expected application/sdp.')
        data=await request.body()
        if len(data)>100_000 or not data.startswith(b'v=0'):raise HTTPException(422,'Invalid SDP offer.')
        session=realtime_session_config(realtime_model,os.getenv('DINEOS_VOICE','marin'),repo.snapshot())
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                response=await client.post('https://api.openai.com/v1/realtime/calls',headers={'Authorization':f'Bearer {key}'},files={'sdp':(None,data.decode()),'session':(None,json.dumps(session))})
        except httpx.HTTPError as e:raise HTTPException(502,f'Realtime connection failed ({type(e).__name__}).') from e
        if not response.is_success:raise HTTPException(502,f'Realtime API returned HTTP {response.status_code}.')
        return PlainTextResponse(response.text,media_type='application/sdp')
    return app

app=create_app()
