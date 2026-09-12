import { z } from 'zod';
export const intentSchema=z.object({
  action:z.enum(['detail','compare','review','confirm','decline','preference','clarify','status']),
  item_ids:z.array(z.enum(['biryani','tandoori','tikka_masala','kadai_chicken'])).max(3),modifiers:z.array(z.enum(['mild','medium','spicy'])).max(1),
  ready_within_minutes:z.number().int().min(1).max(60).nullable(),party_size:z.number().int().min(1).max(12).nullable(),
  offer_id:z.string().nullable(),offer_revision:z.number().int().nullable(),terms_hash:z.string().nullable(),question:z.string().max(240).nullable()
}).strict();
export type VoiceIntent=z.infer<typeof intentSchema>;
export type ItemId=VoiceIntent['item_ids'][number];
export interface MenuItem {id:ItemId;name:string;description:string;price_cents:number;station:string;minutes:number;stock:number;tags:string[];modifiers:string[];estimate_minutes:number|null;fits_preference:boolean;estimate_source:string}
export interface Terms {item_id:ItemId;name:string;quantity:number;modifiers:string[];price_cents:number;ready_in_minutes:number;ready_within_minutes:number;timing_basis:string;party_size:number}
export interface Offer {id:string;revision:number;terms:Terms;terms_hash:string;state_version:number;status:'pending'|'invalidated'|'confirmed'}
export interface Ticket {id:string;table:string;name:string;station:string;minutes:number;ready_by:number;status:'queued'|'started'|'ready';source_kind:string;source_id:string;observed_at:string;simulated:boolean}
export interface Timing {ticket_id:string;start:number|null;end:number|null;ready_by:number;on_time:boolean;station:string}
export interface Action {id:string;kind:'order'|'sequence';status:'requested'|'acknowledged'|'failed';requested_at:string;acknowledged_at:string|null;failure?:string|null;sequence?:string[];ticket?:Ticket;actor:string}
export interface Event {id:string;kind:string;message:string;source_id:string;source_kind:string;simulated:boolean;observed_at:string;state_version:number}
export interface Snapshot {
 epoch:string;state_version:number;revision:number;ui_revision:number;scenario_minute:number;seeded_at:string;paused:boolean;ack_mode:'auto'|'manual'|'fail_next';
 diner:{name:string;table:string;seeded:boolean;party_size:number|null;ready_within_minutes:number;visits?:number;last_order?:string;usual_spice?:string;memory_note?:string};
 menu:MenuItem[];capacity:{value:number|null;source_id:string;source_kind:string;observed_at:string;simulated:boolean;note:string;fresh:boolean};
 tickets:Ticket[];active_sequence:string[];timeline:Timing[];commitments_met:number;commitments_total:number;
 offer:Offer|null;order:{ticket_id:string;action_id:string;status:'requested'|'acknowledged'|'failed';preparation_status:string;terms:Terms;confirmed_at:string}|null;
 actions:Action[];events:Event[];surface:{mode:string;item_ids:ItemId[];message:string;modifiers?:VoiceIntent['modifiers']};
 decision:{rationale:string;alternative_item_id:ItemId|null;diner_message:string;coordinator_question:string|null;model:string;response_id:string;before:string[];after:string[];timeline:Timing[];status:string;decided_at:string}|null;
 planner:{status:string;model:string|null;request_id:string|null;message:string};exceptions:{id:string;message:string;source_kind:string}[]
}
export interface Health {status:string;product:string;openai_key_configured:boolean;planner_model:string;realtime_model:string}
export interface Binding {epoch:string;version:number;ui:number;cancelled:boolean;ready:Promise<unknown>}
export interface Command {command_id:string;epoch:string;expected_state_version:number;expected_ui_revision:number;kind:string;source:'diner'|'coordinator'|'realtime'|'simulator';response_id?:string|null;payload:object}
export function intent(action:VoiceIntent['action'],patch:Partial<VoiceIntent>={}):VoiceIntent {return {action,item_ids:[],modifiers:[],ready_within_minutes:null,party_size:null,offer_id:null,offer_revision:null,terms_hash:null,question:null,...patch};}
export const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(cents/100);
export const modifierName=(m:string)=>m.replaceAll('_',' ');
