import {readFile} from 'node:fs/promises';
import {z} from 'zod';

// Read-only metadata exported by the operator's backup provider. This adapter
// neither creates backups nor treats the live database as a recovery point.
const manifestSchema=z.object({provider:z.string().min(1).max(100),snapshots:z.array(z.object({
  id:z.string().min(1).max(200),organizationId:z.string().uuid(),createdAt:z.string().datetime(),
  status:z.enum(['AVAILABLE','FAILED','PENDING']),sizeBytes:z.number().int().nonnegative().optional(),
})).max(100000)});

export function createBackupProvider(source=process.env,{fetchImpl=fetch}={}){
  if(!source.BACKUP_PROVIDER)return null;
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
  }catch{
    // Do not disclose filesystem paths, provider credentials or internal errors.
    return {available:false,restoreAvailable:false,snapshots:[],reason:'Backup provider tarixini yuklab bo‘lmadi'};
  }
}
