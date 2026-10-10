import {randomToken,sha256} from '../lib/crypto.js';
import {HttpError} from '../lib/http.js';
import {writeAudit} from './audit.js';

// Callers own the transaction. Lock order matches credential writers: org -> user.
export async function issuePasswordReset(client,{organizationId,userId,actorId,reason,identityVerified}){
  if(identityVerified!==true)throw new HttpError(400,'Mijoz shaxsini tasdiqlang','IDENTITY_REQUIRED');
  await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
  const user=(await client.query('SELECT id FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[userId,organizationId])).rows[0];
  if(!user)throw new HttpError(404,'Xodim topilmadi','USER_NOT_FOUND');
  const count=Number((await client.query("SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id=$1 AND created_at>now()-interval '15 minutes'",[userId])).rows[0]?.n||0);
  if(count>=3)throw new HttpError(429,'15 daqiqada ko‘pi bilan 3 marta tiklash mumkin','RESET_RATE_LIMITED');
  await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[userId]);
  const token=randomToken(32);
  const row=(await client.query("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '15 minutes') RETURNING expires_at",[userId,sha256(token)])).rows[0];
  await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[userId]);
  await writeAudit(client,{organizationId,userId:actorId,action:'password_reset_token',entityType:'user',entityId:userId,title:'Bir martalik tiklash tokeni yaratildi',description:reason,metadata:{identityVerified:true}});
  return {token,expiresAt:row.expires_at};
}

export async function consumePasswordReset(client,{token,passwordHash}){
  const hash=sha256(token);
  const target=(await client.query('SELECT t.user_id,u.organization_id FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1',[hash])).rows[0];
  if(!target)throw new HttpError(400,'Tiklash tokeni yaroqsiz yoki eskirgan','RESET_TOKEN_INVALID');
  await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[target.organization_id]);
  const user=(await client.query('SELECT id,active FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE',[target.user_id,target.organization_id])).rows[0];
  const reset=(await client.query('SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND user_id=$2 FOR UPDATE',[hash,target.user_id])).rows[0];
  if(!user||user.active===false||!reset||reset.consumed_at||!(Date.parse(reset.expires_at)>Date.now()))throw new HttpError(400,'Tiklash tokeni yaroqsiz yoki eskirgan','RESET_TOKEN_INVALID');
  await client.query('UPDATE users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1',[target.user_id,passwordHash]);
  await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[target.user_id]);
  await client.query('UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[target.user_id]);
  await writeAudit(client,{organizationId:target.organization_id,userId:target.user_id,action:'password_reset_complete',entityType:'user',entityId:target.user_id,title:'Yangi parol o‘rnatildi'});
}
