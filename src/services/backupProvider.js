import {readFile} from 'node:fs/promises';
import {z} from 'zod';

// Read-only metadata exported by the operator's backup provider. This adapter
// neither creates backups nor treats the live database as a recovery point.
const manifestSchema=z.object({provider:z.string().min(1).max(100),snapshots:z.array(z.object({
  id:z.string().min(1).max(200),organizationId:z.string().uuid(),createdAt:z.string().datetime(),
  scope:z.literal('TENANT').default('TENANT'),status:z.enum(['AVAILABLE','FAILED','PENDING']),sizeBytes:z.number().int().nonnegative().optional(),
})).max(100000)});
const neonId=z.string().regex(/^[a-z0-9-]{1,60}$/);
const date=z.string().datetime({offset:true});
const neonSnapshots=z.object({snapshots:z.array(z.object({
  id:neonId,name:z.string().max(500),created_at:date,source_branch_id:neonId.optional(),
  timestamp:date.optional(),lsn:z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i).optional(),
  expires_at:date.nullable().optional(),full_size:z.number().int().nonnegative().safe().optional(),
})).max(10000)});
const providerError=(code)=>Object.assign(new Error('Backup provider unavailable'),{code});

export function createBackupProvider(source=process.env,{fetchImpl=fetch}={}){
  if(!source.BACKUP_PROVIDER)return null;
  if(source.BACKUP_PROVIDER==='neon'){
    const projectId=neonId.parse(source.NEON_PROJECT_ID),branchId=neonId.parse(source.NEON_BRANCH_ID);
    const token=source.NEON_API_TOKEN||source.BACKUP_API_TOKEN;
    if(!token)throw providerError('BACKUP_CONFIGURATION_REQUIRED');
    // Fixed official origin prevents redirecting provider credentials to another host.
    const get=async(path)=>{
      let response;try{response=await fetchImpl(new URL(`https://console.neon.tech/api/v2/projects/${projectId}${path}`),{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});}catch{throw providerError('BACKUP_PROVIDER_UNREACHABLE')}
      if(!response.ok)throw providerError([401,403].includes(response.status)?'BACKUP_PROVIDER_AUTH_DENIED':'BACKUP_PROVIDER_UNAVAILABLE');
      try{return await response.json()}catch{throw providerError('BACKUP_INVALID_METADATA')}
    };
    return {async listSnapshots(){
      const metadata=neonSnapshots.parse(await get('/snapshots'));
      const {project}=z.object({project:z.object({id:neonId,history_retention_seconds:z.number().int().nonnegative()})}).parse(await get(''));
      if(project.id!==projectId)throw providerError('BACKUP_PROJECT_MISMATCH');
      const snapshots=metadata.snapshots.filter(row=>row.source_branch_id===branchId).map(row=>({
        id:row.id,name:row.name,createdAt:row.created_at,scope:'DATABASE',status:'UNKNOWN',
        statusReason:'Provider listing does not supply restore readiness',sourceBranchId:row.source_branch_id,
        recoveryPoint:row.timestamp||null,lsn:row.lsn||null,expiresAt:row.expires_at||null,...(row.full_size===undefined?{}:{sizeBytes:row.full_size}),
      })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
      return {provider:'Neon',scope:'DATABASE',snapshots,pitr:{supported:project.history_retention_seconds>0,retentionSeconds:project.history_retention_seconds,earliestRecoveryPoint:null},
        warnings:['Snapshots cover the entire database branch, not this organization.','PITR retention is configuration, not a verified recovery timestamp.'],unscopedSnapshots:metadata.snapshots.filter(row=>!row.source_branch_id).length};
    }};
  }
  if(source.BACKUP_PROVIDER==='http'){
    const endpoint=new URL(source.BACKUP_API_URL);
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||!source.BACKUP_API_TOKEN)throw new Error('Backup provider configuration unavailable');
    return {async listSnapshots(organizationId){
      const url=new URL(endpoint);url.searchParams.set('organizationId',organizationId);
      const response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${source.BACKUP_API_TOKEN}`,Accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.ok)throw new Error('Backup provider unavailable');
      const manifest=manifestSchema.parse(await response.json());
      return {provider:manifest.provider,snapshots:manifest.snapshots.filter(row=>row.organizationId===organizationId)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))};
    }};
  }
  if(source.BACKUP_PROVIDER!=='manifest'||!source.BACKUP_MANIFEST_PATH)throw new Error('Backup provider configuration unavailable');
  return {async listSnapshots(organizationId){
    const manifest=manifestSchema.parse(JSON.parse(await readFile(source.BACKUP_MANIFEST_PATH,'utf8')));
    return {provider:manifest.provider,snapshots:manifest.snapshots.filter(row=>row.organizationId===organizationId)
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))};
  }};
}

export async function backupHistory(organizationId,{source=process.env,adapter}={}){
  try{
    const provider=adapter??createBackupProvider(source);
    if(!provider)return {available:false,restoreAvailable:false,snapshots:[],reason:'Backup provider ulanmagan; tiklash tekshirilmagan'};
    const history=await provider.listSnapshots(organizationId);
    return {...history,available:true,restoreAvailable:false,reason:'Provider metadata; tiklash tekshirilmagan'};
  }catch(error){
    // Do not disclose filesystem paths, provider credentials or internal errors.
    return {available:false,restoreAvailable:false,snapshots:[],errorCode:error?.code?.startsWith('BACKUP_')?error.code:'BACKUP_INVALID_METADATA',reason:'Backup provider history could not be verified'};
  }
}

export function recoveryPreview(organizationId,history,snapshotId){
  const snapshot=history.snapshots?.find(row=>row.id===snapshotId);
  if(!history.available||!snapshot)throw providerError('RECOVERY_SNAPSHOT_NOT_FOUND');
  if(snapshot.scope==='TENANT'&&snapshot.organizationId!==organizationId)throw providerError('RECOVERY_TENANT_MISMATCH');
  const scope=snapshot.scope||'UNKNOWN';
  return {organizationId,snapshot,scope,restoreAvailable:false,dryRun:true,diffComputed:false,estimatedChanges:null,
    affectedScope:scope==='DATABASE'?'Entire database branch; all organizations':'Selected tenant only after ownership and dependencies are verified',
    conflicts:scope==='DATABASE'?['DATABASE_SNAPSHOT_CANNOT_REPLACE_ONE_TENANT']:scope==='UNKNOWN'?['SNAPSHOT_SCOPE_UNVERIFIED']:[],
    requirements:['Separate disposable recovery branch','Verified tenant ownership and referential/financial/stock comparison','Explicit operator confirmation','Audit and tested rollback plan'],rollbackVerified:false};
}

export const backupPageSchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).max(100000).default(0),snapshotId:z.string().min(1).max(200).optional()}).strict();
export function backupPage(history,{limit=20,offset=0}={}){
  const {snapshots=[],...metadata}=history;
  const successful=snapshots.find(row=>row.status==='AVAILABLE');
  return {...metadata,snapshots:snapshots.slice(offset,offset+limit),total:snapshots.length,hasMore:offset+limit<snapshots.length,
    limit,offset,lastSuccessfulBackupAt:successful?.createdAt||null};
}
