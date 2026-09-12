import type {Snapshot,Command,Offer} from './types';
export const uid=(prefix='cmd')=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
export function acceptSnapshot(current:Snapshot|null,next:Snapshot):Snapshot {
  return !current || next.revision>current.revision ? next : current;
}
export function commandFor(s:Snapshot,kind:string,payload:object,source:Command['source']='coordinator'):Command {
  return {command_id:uid(),epoch:s.epoch,expected_state_version:s.state_version,expected_ui_revision:s.ui_revision,kind,source,payload};
}
export function confirmation(offer:Offer){return {offer_id:offer.id,offer_revision:offer.revision,terms_hash:offer.terms_hash};}
