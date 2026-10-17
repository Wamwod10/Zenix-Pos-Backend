import {HttpError} from '../lib/http.js';
import {requestFingerprint} from './posReplay.js';

// Match the organization -> business-row order used by subscription/shift writes.
export const lockFinancialOrganization=(client,organizationId)=>client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);

export async function financialWriteReplay(client,{organizationId,userId,operation,clientReference,input},write){
 await lockFinancialOrganization(client,organizationId);
 if(!clientReference)return write(); // Existing clients retain their API contract.
 const fingerprint=requestFingerprint(input);
 const previous=(await client.query(`SELECT user_id,request_fingerprint,result FROM financial_write_replays
  WHERE organization_id=$1 AND operation=$2 AND client_reference=$3`,[organizationId,operation,clientReference])).rows[0];
 if(previous){
  if(previous.user_id!==userId||previous.request_fingerprint!==fingerprint)throw new HttpError(409,'Bu identifikator boshqa amal uchun ishlatilgan','IDEMPOTENCY_CONFLICT');
  return previous.result;
 }
 const result=await write();
 await client.query(`INSERT INTO financial_write_replays(organization_id,operation,client_reference,user_id,request_fingerprint,result)
  VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[organizationId,operation,clientReference,userId,fingerprint,JSON.stringify(result)]);
 return result;
}
