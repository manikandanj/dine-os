import {describe,it,expect,vi} from 'vitest';
import {RealtimeVoiceClient} from '../realtime';
import {intent} from '../types';
function make(){
 const callbacks={onStatus:vi.fn(),onResponseStarted:vi.fn(),onInterruption:vi.fn(),onToolCall:vi.fn(async()=>({ok:true,accepted_result:{state_version:2}})),onLatency:vi.fn()};
 const client=new RealtimeVoiceClient(callbacks);
 const internals=client as unknown as {send:(e:object)=>void;handleEvent:(e:object)=>Promise<void>;channel:unknown;microphone:MediaStream};
 const track={enabled:true,stop:vi.fn()};
 internals.microphone={getAudioTracks:()=>[track],getTracks:()=>[track]} as unknown as MediaStream;
 const send=vi.spyOn(internals,'send');return {client,callbacks,track,send,handle:internals.handleEvent.bind(client),internals};
}
const call=(response='old')=>({type:'response.function_call_arguments.done',response_id:response,call_id:'call_1',name:'dineos_intent',arguments:JSON.stringify(intent('detail',{item_ids:['kadai_chicken']}))});
describe('Realtime generation and audio guards',()=>{
 it('does not cancel ordinary initial speech',async()=>{const m=make();await m.handle({type:'input_audio_buffer.speech_started'});expect(m.callbacks.onInterruption).not.toHaveBeenCalled();expect(m.send).not.toHaveBeenCalled();});
 it('binds a validated restaurant tool to its originating response',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle(call());expect(m.callbacks.onToolCall).toHaveBeenCalledWith(expect.objectContaining({item_ids:['kadai_chicken']}),'call_1','old');});
 it('rejects a late explicitly interrupted tool even after a new response starts',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'old'}});m.client.interrupt();await m.handle({type:'response.created',response:{id:'new'}});await m.handle(call());expect(m.callbacks.onToolCall).not.toHaveBeenCalled();});
 it('never binds a tool missing response_id to a fresh response',async()=>{const m=make();await m.handle({type:'response.created',response:{id:'new'}});await m.handle({...call(),response_id:undefined});expect(m.callbacks.onToolCall).not.toHaveBeenCalled();});
 it.each(['tap','speech'])('does not resurrect speech if a %s interrupts while the tool awaits HTTP',async(interruption)=>{
  const m=make();let resolve!:(r:{ok:boolean;accepted_result:{state_version:number}})=>void;
  m.callbacks.onToolCall.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  await m.handle({type:'response.created',response:{id:'old'}});const pending=m.handle(call());
  if(interruption==='tap')m.client.interrupt();else await m.handle({type:'input_audio_buffer.speech_started'});
  m.send.mockClear();resolve({ok:true,accepted_result:{state_version:2}});await pending;
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

describe('Open microphone and spoken interruptions',()=>{
 it('keeps capture enabled and cancels Mira when the diner starts speaking',async()=>{
  const m=make();await m.handle({type:'input_audio_buffer.speech_stopped'});expect(m.track.enabled).toBe(true);
  await m.handle({type:'response.created',response:{id:'reply'}});m.callbacks.onStatus.mockClear();m.send.mockClear();
  await m.handle({type:'input_audio_buffer.speech_started'});
  expect(m.callbacks.onInterruption).toHaveBeenCalledWith('reply');expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('listening');
  expect(m.send).toHaveBeenCalledWith({type:'response.cancel'});expect(m.send).toHaveBeenCalledWith({type:'output_audio_buffer.clear'});
  await m.handle({type:'response.done',response:{id:'reply'}});expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('listening');
  await m.handle({type:'input_audio_buffer.speech_stopped'});expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('responding');
  expect(m.track.enabled).toBe(true);expect(m.send).not.toHaveBeenCalledWith({type:'input_audio_buffer.clear'});
 });
 it('keeps the mic open during playback without clearing captured speech when audio drains',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'reply'}});
  expect(m.track.enabled).toBe(true);
  await m.handle({type:'output_audio_buffer.started',response_id:'reply'});
  expect(m.track.enabled).toBe(true);
  await m.handle({type:'response.done',response:{id:'reply'}});
  expect(m.track.enabled).toBe(true);expect(m.callbacks.onStatus).not.toHaveBeenCalledWith('connected');
  await m.handle({type:'output_audio_buffer.stopped',response_id:'reply'});
  expect(m.track.enabled).toBe(true);expect(m.send).not.toHaveBeenCalledWith({type:'input_audio_buffer.clear'});
  expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
  await m.handle({type:'input_audio_buffer.speech_started'});expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('listening');
 });
 it('resumes after a response without audio',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'reply'}});
  expect(m.track.enabled).toBe(true);await m.handle({type:'response.done',response:{id:'reply'}});expect(m.track.enabled).toBe(true);
  expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
 });
 it('keeps capture enabled through an asynchronous tool and its follow-up narration',async()=>{
  const m=make();let resolve!:(r:{ok:boolean;accepted_result:{state_version:number}})=>void;
  m.callbacks.onToolCall.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  await m.handle({type:'response.created',response:{id:'old'}});const pending=m.handle(call());
  await m.handle({type:'response.done',response:{id:'old'}});expect(m.track.enabled).toBe(true);
  resolve({ok:true,accepted_result:{state_version:2}});await pending;expect(m.track.enabled).toBe(true);
  expect(m.send).toHaveBeenCalledWith({type:'response.create'});
  await m.handle({type:'response.created',response:{id:'followup'}});await m.handle({type:'output_audio_buffer.started',response_id:'followup'});
  await m.handle({type:'response.done',response:{id:'followup'}});expect(m.track.enabled).toBe(true);
  await m.handle({type:'output_audio_buffer.stopped',response_id:'followup'});expect(m.track.enabled).toBe(true);
 });
 it('does not mark a newer response idle when old playback drains',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle({type:'output_audio_buffer.started',response_id:'old'});
  await m.handle({type:'response.done',response:{id:'old'}});await m.handle({type:'response.created',response:{id:'new'}});
  await m.handle({type:'output_audio_buffer.started',response_id:'new'});await m.handle({type:'response.done',response:{id:'new'}});
  m.callbacks.onStatus.mockClear();
  await m.handle({type:'output_audio_buffer.stopped',response_id:'old'});expect(m.track.enabled).toBe(true);expect(m.callbacks.onStatus).not.toHaveBeenCalled();
  await m.handle({type:'output_audio_buffer.stopped',response_id:'new'});expect(m.track.enabled).toBe(true);
  expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('connected');
 });
 it.each(['tap','speech'])('allows a %s to stop buffered audio after generation has finished',async(interruption)=>{
  const m=make();await m.handle({type:'response.created',response:{id:'old'}});await m.handle({type:'output_audio_buffer.started',response_id:'old'});
  await m.handle({type:'response.done',response:{id:'old'}});
  if(interruption==='tap')m.client.interrupt();else await m.handle({type:'input_audio_buffer.speech_started'});
  expect(m.send).toHaveBeenCalledWith({type:'output_audio_buffer.clear'});expect(m.callbacks.onInterruption).toHaveBeenCalledWith('old');
  expect(m.track.enabled).toBe(true);await m.handle({type:'output_audio_buffer.cleared',response_id:'old'});expect(m.track.enabled).toBe(true);
  expect(m.callbacks.onStatus).toHaveBeenLastCalledWith(interruption==='speech'?'listening':'connected');
  await m.handle(call());expect(m.callbacks.onToolCall).not.toHaveBeenCalled();
 });
 it('releases capture on an API error and ignores late playback events after disconnect',async()=>{
  const m=make();await m.handle({type:'response.created',response:{id:'reply'}});
  await m.handle({type:'error',error:{message:'Voice service unavailable'}});expect(m.track.stop).toHaveBeenCalled();
  expect(m.callbacks.onStatus).toHaveBeenLastCalledWith('error','Voice service unavailable');
  m.callbacks.onStatus.mockClear();await m.handle({type:'output_audio_buffer.stopped',response_id:'reply'});expect(m.callbacks.onStatus).not.toHaveBeenCalled();
 });
});
