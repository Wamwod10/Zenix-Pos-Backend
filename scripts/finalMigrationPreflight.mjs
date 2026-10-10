import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
export async function finalMigrationPreflight(client){
 await client.query('BEGIN READ ONLY');
 try{
  const holdsColumn=(await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sale_holds' AND column_name='client_reference'")).rowCount>0;
  const holdDuplicates=holdsColumn?(await client.query("SELECT count(*)::int count FROM (SELECT organization_id,client_reference FROM sale_holds WHERE client_reference<>'' GROUP BY organization_id,client_reference HAVING count(*)>1) d")).rows[0].count:0;
  const paymentDuplicates=(await client.query("SELECT count(*)::int count FROM (SELECT organization_id,metadata->>'clientReference' FROM customer_ledger WHERE entry_type='PAYMENT' AND COALESCE(metadata->>'clientReference','')<>'' GROUP BY organization_id,metadata->>'clientReference' HAVING count(*)>1) d")).rows[0].count;
  const receiptDuplicates=(await client.query("SELECT count(*)::int count FROM (SELECT organization_id,metadata->>'clientReference' FROM audit_logs WHERE action='receive' AND entity_type='inventory' AND COALESCE(metadata->>'clientReference','')<>'' GROUP BY organization_id,metadata->>'clientReference' HAVING count(*)>1) d")).rows[0].count;
  const unvalidated=(await client.query("SELECT conname,conrelid::regclass::text table_name FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated ORDER BY conname")).rows;
  const invalidIndexes=(await client.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid")).rows;
  return {ok:holdDuplicates===0&&paymentDuplicates===0&&receiptDuplicates===0&&!invalidIndexes.length,duplicateGroups:{holds:holdDuplicates,payments:paymentDuplicates,receipts:receiptDuplicates},holdsColumnPresent:holdsColumn,unvalidatedConstraints:unvalidated,invalidIndexes};
 }finally{await client.query('ROLLBACK')}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL,{nodeEnv:process.env.NODE_ENV});
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const client=await pool.connect();
 try{const result=await finalMigrationPreflight(client);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1}
 finally{client.release();await pool.end()}
}
