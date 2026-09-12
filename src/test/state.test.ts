import {describe,it,expect,vi} from 'vitest';
import {acceptSnapshot,commandFor,confirmation} from '../state';
import {sendCommand,ApiError} from '../api';
import type {Snapshot,Offer} from '../types';
const state={epoch:'epoch_one',revision:4,state_version:2,ui_revision:3} as Snapshot;
describe('DineOS operational and presentation boundaries',()=>{
 it('ignores old poll and retry results even across reset',()=>{
  expect(acceptSnapshot(state,{...state,revision:3})).toBe(state);
  const reset={...state,epoch:'fresh',revision:5,state_version:3,ui_revision:0};
  expect(acceptSnapshot(state,reset)).toBe(reset);
  expect(acceptSnapshot(reset,state)).toBe(reset);
 });
 it('captures original versions and exact offer identity',()=>{
  const c=commandFor(state,'intent',{action:'confirm'},'diner');
  expect(c.expected_state_version).toBe(2);expect(c.expected_ui_revision).toBe(3);expect(c.epoch).toBe('epoch_one');
  expect(confirmation({id:'offer1',revision:8,terms_hash:'bound_terms'} as Offer)).toEqual({offer_id:'offer1',offer_revision:8,terms_hash:'bound_terms'});
 });
 it('retries a lost network response using the exact same command',async()=>{
  const fetch=vi.fn().mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValue({ok:true,json:async()=>state});vi.stubGlobal('fetch',fetch);
  const c=commandFor(state,'intent',{action:'confirm'},'diner');await sendCommand(c);
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);vi.unstubAllGlobals();
 });
 it('does not restamp or retry a stale purchase',async()=>{
  const fetch=vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({detail:'Review again',snapshot:state})});vi.stubGlobal('fetch',fetch);
  await expect(sendCommand(commandFor(state,'intent',{}))).rejects.toBeInstanceOf(ApiError);expect(fetch).toHaveBeenCalledTimes(1);vi.unstubAllGlobals();
 });
});
