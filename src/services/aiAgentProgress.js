import {HttpError} from '../lib/http.js';
import {authorizationKey} from './aiPolicy.js';

const phases=new Set(['understanding','reading_sales','reading_inventory','preparing_action','composing','verifying','complete','failed']);
const progress=new Map(),limit=512,ttl=60000;
const key=(user,id)=>JSON.stringify([user.organizationId,user.id,user.sessionId,id]);
// Ephemeral status only: no prompts, facts, tokens, financial data or action IDs.
// Another instance may not have the entry; clients must then use generic loading.
export function recordAgentProgress(user,id,phase,now=Date.now()){
 if(!phases.has(phase))throw new Error('Invalid AI progress phase');
 for(const [k,value] of progress)if(value.expiresAt<=now)progress.delete(k);
 const k=key(user,id);progress.delete(k);
 if(progress.size>=limit)progress.delete(progress.keys().next().value);
 progress.set(k,{phase,authorization:authorizationKey(user),expiresAt:now+ttl});
}
export function getAgentProgress(user,id,now=Date.now()){
 const k=key(user,id),entry=progress.get(k);
 if(!entry||entry.expiresAt<=now){progress.delete(k);throw new HttpError(404,'Jarayon holati mavjud emas','AI_PROGRESS_UNAVAILABLE')}
 if(entry.authorization!==authorizationKey(user))throw new HttpError(403,'Ruxsatlar o‘zgargan','AI_ACCESS_CHANGED');
 return {phase:entry.phase};
}
