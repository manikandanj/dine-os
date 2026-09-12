from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')

class VoiceIntent(StrictModel):
    action: Literal['detail','compare','review','confirm','decline','preference','clarify','status']
    item_ids: list[Literal['chicken','mushroom','soup']] = Field(max_length=2)
    modifiers: list[Literal['sauce_on_side','no_herbs']] = Field(max_length=2)
    ready_within_minutes: int | None = Field(ge=1, le=60)
    party_size: int | None = Field(ge=1, le=12)
    offer_id: str | None
    offer_revision: int | None
    terms_hash: str | None
    question: str | None = Field(max_length=240)

    @model_validator(mode='after')
    def shape(self):
        if len(set(self.item_ids)) != len(self.item_ids) or len(set(self.modifiers)) != len(self.modifiers):
            raise ValueError('Items and modifiers must be unique')
        if self.action in ('detail','review') and len(self.item_ids) != 1:
            raise ValueError('Select exactly one dish')
        if self.action == 'compare' and len(self.item_ids) != 2:
            raise ValueError('Compare exactly two dishes')
        if self.action == 'confirm' and not all((self.offer_id, self.offer_revision, self.terms_hash)):
            raise ValueError('Confirmation must reference the exact reviewed offer')
        return self

class Command(StrictModel):
    command_id: str = Field(min_length=3,max_length=100,pattern=r'^[a-zA-Z0-9_-]+$')
    expected_state_version: int = Field(ge=0)
    expected_ui_revision: int = Field(ge=0)
    epoch: str
    kind: Literal['intent','report','pause','override','ack_mode','ack','reset','replan','progress']
    source: Literal['diner','coordinator','realtime','simulator']
    response_id: str | None = None
    payload: dict = Field(default_factory=dict)

class Report(StrictModel):
    capacity: int | None = Field(ge=0,le=2)
    source_id: str = Field(min_length=1,max_length=60)
    source_kind: Literal['human_report','recorded','unknown']
    observed_at: str
    simulated: Literal[True]
    note: str = Field(min_length=1,max_length=240)

class Pause(StrictModel):
    paused: bool
class Override(StrictModel):
    sequence: list[str] = Field(min_length=1,max_length=8)
    reason: str = Field(min_length=1,max_length=240)
class AckMode(StrictModel):
    mode: Literal['auto','manual','fail_next']
class Ack(StrictModel):
    action_id: str
    success: bool
class Progress(StrictModel):
    ticket_id: str
    status: Literal['started','ready']
class Empty(StrictModel):
    pass
class Generation(StrictModel):
    command_id: str
    response_id: str
    epoch: str
    expected_state_version: int
    expected_ui_revision: int
    cancelled: bool

class PlannerProposal(StrictModel):
    observed_state_version: int
    sequence: list[str] = Field(max_length=8)
    rationale: str = Field(min_length=1,max_length=500)
    alternative_item_id: Literal['chicken','mushroom','soup'] | None
    diner_message: str = Field(max_length=300)
    coordinator_question: str | None = Field(max_length=240)

PLANNER_TOOL_NAMES = ('propose_preparation_sequence','request_coordinator_update','propose_diner_alternative')
PLANNER_TOOLS = [dict(type='function', name=name, description=description, strict=True, parameters=PlannerProposal.model_json_schema()) for name, description in zip(PLANNER_TOOL_NAMES, (
    'Propose a preparation sequence and optionally an honest diner alternative. All ticket IDs must be present exactly once. Code validates timings and applies the action through the kitchen simulator.',
    'Ask a targeted coordinator question when capacity is unknown/stale or commitments cannot all be met. This does not change the active sequence.',
    'Offer a feasible alternative without changing any diner choice. Include the unchanged active sequence. This does not confirm an order.'
))]
REALTIME_TOOL = dict(type='function',name='dineos_intent',description='Synchronize the diner screen with an authorized menu, comparison, review, confirmation, clarification or status. Prices and timing are supplied by the server. A review reserves nothing. Confirmation requires exact server offer identity, revision and terms hash.', parameters=VoiceIntent.model_json_schema())
