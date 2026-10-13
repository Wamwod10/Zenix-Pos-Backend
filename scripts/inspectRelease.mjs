// Read-only release evidence. Never migrations, snapshots, restores or deploys.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'dotenv';
import pg from 'pg';
import {createBackupProvider} from '../src/services/backupProvider.js';
const file=process.env.RELEASE_READONLY_ENV_FILE||path.join(os.tmpdir(),'zenix-release-readonly.env');
let configured={};try{configured=parse(await fs.readFile(file))}catch(error){if(error.code!=='ENOENT')throw error}
const source={...configured,...process.env},result={checkedAt:new Date().toISOString(),mode:'READ_ONLY',public:[]};
const failure=e=>({verified:false,code:typeof e.code==='string'?e.code:'READ_FAILED'});
async function json(url,token){const r=await fetch(url,{method:'GET',headers:token?{Authorization:`Bearer ${token}`,Accept:'application/json'}:{},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Object.assign(new Error('Read failed'),{code:`HTTP_${r.status}`});return r.json()}
await Promise.all(['/','/health','/ready','/api/billing/plans','/api/ai/status'].map(async suffix=>{
 try{const r=await fetch(`https://zenixpos.uz${suffix}`,{signal:AbortSignal.timeout(15000)});const body=await r.text();let value;try{value=JSON.parse(body)}catch{}
  result.public.push({path:suffix,status:r.status,server:r.headers.get('server'),vercelId:r.headers.get('x-vercel-id'),body:value?{ok:value.ok,service:value.service,database:value.database,errorCode:value.error?.code}:undefined,html:!value&&body.includes('<html')});
 }catch(e){result.public.push({path:suffix,...failure(e)})}
}));
result.render={verified:false,code:'CREDENTIAL_NOT_CONFIGURED'};
if(source.RENDER_API_KEY){try{
 const rows=await json('https://api.render.com/v1/services?limit=100',source.RENDER_API_KEY);
 result.render={verified:true,services:await Promise.all(rows.map(r=>r.service).filter(s=>String(s.repo||'').includes('Wamwod10/Zenix-Pos-Backend')).map(async s=>{
  const deployments=await json(`https://api.render.com/v1/services/${encodeURIComponent(s.id)}/deploys?limit=3`,source.RENDER_API_KEY);
  return {id:s.id,name:s.name,type:s.type,branch:s.branch,autoDeploy:s.autoDeploy,suspended:s.suspended,url:s.serviceDetails?.url,deployments:deployments.map(r=>{const d=r.deploy;return {id:d.id,status:d.status,commit:d.commit?.id,createdAt:d.createdAt,finishedAt:d.finishedAt}})};
 }))};
 }catch(e){result.render=failure(e)}
}
result.neon={verified:false,code:'CREDENTIAL_NOT_CONFIGURED'};
if(source.NEON_API_TOKEN&&source.NEON_PROJECT_ID&&source.NEON_BRANCH_ID){try{
 result.neon={verified:true,...await createBackupProvider({...source,BACKUP_PROVIDER:'neon'}).listSnapshots()};
 }catch(e){result.neon=failure(e)}
}
for(const [name,key] of [['staging','STAGING_DATABASE_URL'],['productionSchema','PRODUCTION_DATABASE_URL']]){
 result[name]={verified:false,code:'CONNECTION_NOT_CONFIGURED'};if(!source[key])continue;
 const db=new pg.Pool({connectionString:source[key],max:1,connectionTimeoutMillis:10000,application_name:'zenix_release_readonly'});
 let client;try{
  client=await db.connect();await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='10s'");
  const rows=(await client.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  result[name]={verified:true,migrations:rows.map(r=>({name:r.name,checksumPresent:Boolean(r.checksum)})),readOnly:(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only};
 }catch(e){result[name]=failure(e)}finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release()}await db.end()}
}
console.log(JSON.stringify(result,null,2));
