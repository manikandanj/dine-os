import type {Snapshot,Command,Health} from './types';
const ROOT=(import.meta.env.VITE_API_ROOT??'').replace(/\/$/,'');
export class ApiError extends Error {constructor(message:string,public status:number,public snapshot?:Snapshot){super(message);}}
export async function request<T>(path:string,body?:object):Promise<T>{
 const response=await fetch(ROOT+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 const data=await response.json();
 if(!response.ok)throw new ApiError(typeof data.detail==='string'?data.detail:'The request could not be applied.',response.status,data.snapshot);
 return data as T;
}
export const getSnapshot=()=>request<Snapshot>('/api/state');
export const getHealth=()=>request<Health>('/api/health');
// Only a lost network response is retried, with the IDENTICAL command. Never restamp a conflict.
export async function sendCommand(cmd:Command):Promise<Snapshot>{
 try{return await request<Snapshot>('/api/commands',cmd);}catch(e){if(e instanceof TypeError)return request<Snapshot>('/api/commands',cmd);throw e;}
}
export const generation=(body:object)=>request('/api/voice/generations',body);
