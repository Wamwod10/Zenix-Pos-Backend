import { pool } from "./pool.js";
import {requestScope} from '../lib/requestScope.js';
import {HttpError} from '../lib/http.js';

export async function lockBusinessScope(client){
  const scope=requestScope.getStore();
  if(!scope?.businessWrite||!scope.organizationId)return;
  await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[scope.organizationId]);
  const row=(await client.query('SELECT subscription_can_write($1) AS writable',[scope.organizationId])).rows[0];
  if(row?.writable!==true)throw new HttpError(402,'Biznes faqat o‘qish rejimida','LICENSE_EXPIRED');
}

const ISOLATION_LEVELS=new Map([
  ["read committed","READ COMMITTED"],
  ["repeatable read","REPEATABLE READ"],
  ["serializable","SERIALIZABLE"],
]);

const beginStatement=(isolationLevel)=>{
  if(!isolationLevel)return "BEGIN";
  const normalized=String(isolationLevel).trim().toLowerCase();
  const sql=ISOLATION_LEVELS.get(normalized);
  if(!sql)throw new Error("Unsupported transaction isolation level: "+isolationLevel);
  return "BEGIN ISOLATION LEVEL "+sql;
};

export async function runTransaction(db,work,{isolationLevel}={}){
  const begin=beginStatement(isolationLevel);
  const client=await db.connect();
  let phase="begin";
  let releaseError;
  try{
    await client.query(begin);
    await lockBusinessScope(client);
    phase="work";
    const result=await work(client);
    phase="commit";
    await client.query("COMMIT");
    phase="done";
    return result;
  }catch(error){
    if(phase==="begin"||phase==="commit")releaseError=error;
    try{await client.query("ROLLBACK")}
    catch(rollbackError){
      releaseError=rollbackError;
      if(error&&typeof error==="object")Object.defineProperty(error,"rollbackError",{value:rollbackError,configurable:true});
    }
    throw error;
  }finally{
    client.release(releaseError);
  }
}

export function withTransaction(work,options){
  return runTransaction(pool,work,options);
}
