import { assertSafeTestDatabaseUrl } from './assertTestDatabase.js';
import { recoverySnapshot,compareRecoverySnapshots,recoveryRowManifest,compareRecoveryRowManifests } from '../src/services/tenantRecovery.js';

const id=process.argv[2];
const rowLevel=process.argv.includes('--rows');
const sourceUrl=process.env.RECOVERY_SOURCE_DATABASE_URL;
const targetUrl=process.env.RECOVERY_TARGET_DATABASE_URL;
const safeTarget=value=>{
  // Recovery runs against offline, loopback test copies under the same repository
  // safety convention as DB tests. No override for remote/production is provided.
  const parsed=assertSafeTestDatabaseUrl(value);
  const database=decodeURIComponent(parsed.pathname.slice(1));
  if(/prod|production|live/i.test(database)||parsed.hash||[...parsed.searchParams.keys()].some(key=>key!=='sslmode'))throw Error('Unsafe target');
  return parsed;
};
const endpoint=url=>`${['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname)?'loopback':url.hostname}:${url.port||'5432'}:${decodeURIComponent(url.pathname)}`;
if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id||'')||!sourceUrl||!targetUrl||process.argv.slice(3).some(arg=>arg!=='--rows')){
  console.error('Recovery requires an organization UUID and two safe offline database targets');process.exitCode=2;
}else{
  let source,target;
  try{
    source=safeTarget(sourceUrl);target=safeTarget(targetUrl);
    if(endpoint(source)===endpoint(target))throw Error('Same endpoint');
  }catch{
    console.error('Unsafe or non-independent recovery database targets');process.exitCode=2;
  }
  if(!process.exitCode){
    const pools=[];
    try{
      const [{default:pg},{createMigrationPoolConfig}]=await Promise.all([import('pg'),import('../src/db/config.js')]);
      for(const databaseUrl of [sourceUrl,targetUrl])pools.push(new pg.Pool(createMigrationPoolConfig({
        databaseUrl,isProduction:false,connectionTimeoutMs:10000,statementTimeoutMs:10000,queryTimeoutMs:10000,idleTransactionTimeoutMs:10000,
      })));
      const [before,after]=await Promise.all(pools.map(pool=>rowLevel?recoveryRowManifest(pool,id):recoverySnapshot(pool,id)));
      console.log(JSON.stringify(rowLevel?compareRecoveryRowManifests(before,after):compareRecoverySnapshots(before,after),null,2));
    }catch{
      // Driver errors can contain credentials, URLs or row contents; emit a fixed code.
      console.error('Recovery comparison failed: RECOVERY_COMPARISON_FAILED');process.exitCode=1;
    }finally{await Promise.all(pools.map(pool=>pool.end()));}
  }
}
