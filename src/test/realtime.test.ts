import {describe,it,expect,vi} from 'vitest';
import {RealtimeVoiceClient} from '../realtime';
import {intent} from '../types';
function make(){
 const callbacks={onStatus:vi.fn(),onResponseStarted:vi.fn(),onInterruption:vi.fn(),onToolCall:vi.fn(async()=>({ok:true,accepted_result:{state_version:2}})),onLatency:vi.fn()};
 const client=new RealtimeVoiceClient(callbacks);
 const internals=client as unknown as {send:(e:object)=>void;handleEvent:(e:object)=>Promise<void>;channel:unknown};
 const send=vi.spyOn(internals,'send');return {client,callbacks,send,handle:internals.handleEvent.bind(client),internals};
}
const call=(response='old')=>({type:'response.function_call_arguments.done',response_id:response,call_id:'call_1',name:'dineos_intent',arguments:JSON.stringify(intent('detail',{item_ids:['chicken']}))});
describe('Realtime generation and audio guards',()=>{
 it('does not cancel ordinary initial speech',async()=>{const m=make();await m.handle({type:'input_audio_buffer.speech_started'});expect(m.callbacks.onInterruption).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();});
 it('binds a validated restaurant tool to its originating response',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle(call());expect(m.callbacks.onToolCall).toHaveBeenCalledWith(expect.objectContaining({item_ids:['chicken']}),'call_1','old');});
 it('rejects a late interrupted tool even after a new response starts',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle({type:'input_audio_buffer.speech_started'});await m.handle({type:'response.created',response:{id:'new'}});await m.handle(call());expect(m.callbacks.onToolCall).not.toHaveBeenCalled();});
 it('never binds a tool missing response_id to a fresh response',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'new'}});await m.handle({...call(),response_id:undefined});expect(m.callbacks.onToolCall).not.toHaveBeenCalled();});
 it('does not resurrect speech if interruption occurs while the tool awaits HTTP',async()=>{
  const m=make();let resolve!:(r:{ok:boolean;accepted_result:{state_version:number}})=>void;
  m.callbacks.onToolCall.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  await m.handle({type:'response.created',response:{id:'old'}});const pending=m.handle(call());
  await m.handle({type:'input_audio_buffer.speech_started'});m.send.mockClear();resolve({ok:true,accepted_result:{state_version:2}});await pending;
  expect(m.send.mock.calls.some(([e])=>(e as {type:string}).type==='response.create')).toBe(false);
 });
 it('deduplicates paired function/output-item notifications',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle(call());await m.handle(call());expect(m.callbacks.onToolCall).toHaveBeenCalledTimes(1);});
 it('injects authoritative state and invalidates obsolete narration on an external acknowledgment',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'old'}});m.client.syncContext({state_version:3,order:{status:'acknowledged'}},'kitchen_ack',true);
  expect(m.callbacks.onInterruption).toHaveBeenCalledWith('old');expect(JSON.stringify(m.send.mock.calls)).toContain('acknowledged');
 });
 it('rejects all tool events after disconnect/reset',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});m.client.disconnect();await m.handle(call());expect(m.callbacks.onToolCall).not.toHaveBeenCalled();});
 it('waits for server cancellation before narrating an external acknowledgment',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'old'}});m.client.syncContext({order:{status:'acknowledged'}},'ack',true);
  expect(m.send.mock.calls.filter(([e])=>(e as {type:string}).type==='response.create')).toHaveLength(0);
  await m.handle({type:'response.done',response:{id:'old'}});
  expect(m.send.mock.calls.filter(([e])=>(e as {type:string}).type==='response.create')).toHaveLength(1);
  expect(JSON.stringify(m.send.mock.calls)).toContain('A pending request is not an acknowledgment');
 });
 it('does not let a cancellation acknowledgment idle a newer voice response',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'old'}});m.client.syncContext({state_version:2},'ack',true);
  await m.handle({type:'response.created',response:{id:'new'}});m.send.mockClear();m.callbacks.onStatus.mockClear();
  await m.handle({type:'response.done',response:{id:'old'}});expect(m.send).not.toHaveBeenCalled();expect(m.callbacks.onStatus).not.toHaveBeenCalled();
 });
 it('ignores an old response.done that would mark a new response idle',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle({type:'response.created',response:{id:'new'}});m.callbacks.onStatus.mockClear();await m.handle({type:'response.done',response:{id:'old'}});expect(m.callbacks.onStatus).not.toHaveBeenCalled();});
});
