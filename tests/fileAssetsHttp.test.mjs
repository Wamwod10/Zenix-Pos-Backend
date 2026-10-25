import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {assertFileAssetBinding} from '../src/services/fileAssets.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('file purpose, uploader, tenant and attachment security through HTTP',{timeout:30000},async t=>{
  assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});assert.equal(process.env.DATABASE_URL,url);
  const [{default:pg},{default:bcrypt},{app},{pool:appPool}]=await Promise.all([import('pg'),import('bcryptjs'),import('../src/app.js'),import('../src/db/pool.js')]);
  const db=new pg.Pool({connectionString:url,max:4,options:'-c lock_timeout=5s -c statement_timeout=15s'});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`,token=randomUUID(),password=`FileTest!${token}`;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(12)]);
  async function request(path,{cookie,method='GET',body,headers={}}={}){
    const response=await fetch(base+path,{method,headers:{origin:'http://localhost:5173','x-zenix-client':'web',...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const payload=response.headers.get('content-type')?.includes('application/json')?await response.json():null;
    return {status:response.status,payload,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try{
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES($1,'ACTIVE',CURRENT_DATE+30,2) RETURNING id",[`file-purpose-${token}`])).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'File store') RETURNING id",[org])).rows[0].id;
    const otherStore=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other file store') RETURNING id",[org])).rows[0].id;
    const hash=await bcrypt.hash(password,4);
    async function account(name,permissions={},organizationId=org,role='MANAGER',storeId=store){
      const overrides={moduleProducts:false,productWrite:false,moduleExpenses:false,expensesWrite:false,moduleSales:false,moduleInventory:false,settingsWrite:false,...permissions};
      const username=`file-${name}-${token}`;
      const id=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role,permission_overrides,store_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[organizationId,name,username,hash,role,overrides,organizationId===org?storeId:null])).rows[0].id;
      const login=await request('/api/auth/login',{method:'POST',body:{username,password}});assert.equal(login.status,200,JSON.stringify(login.payload));
      return {id,cookie:login.cookie,user:{id,organizationId,appRole:role,permissionOverrides:overrides,storeId:organizationId===org?storeId:null}};
    }
    const product=await account('product',{moduleProducts:true,productWrite:true});
    const productOther=await account('product-other',{moduleProducts:true,productWrite:true});
    const expense=await account('expense',{moduleExpenses:true,expensesWrite:true});
    const expenseReader=await account('expense-reader',{moduleExpenses:true});
    const sales=await account('sales',{moduleSales:true});
    const admin=await account('owner',{},org,'OWNER');
    const foreignOrg=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE',CURRENT_DATE+30) RETURNING id",[`foreign-files-${token}`])).rows[0].id;
    const foreign=await account('foreign',{},foreignOrg,'OWNER');
    const upload=async(actor,purpose)=>{
      const result=await request('/api/files',{cookie:actor.cookie,method:'POST',body:png,headers:{'content-type':'image/png','x-file-name':'proof.png',...(purpose?{'x-file-purpose':purpose}:{})}});
      assert.equal(result.status,201,JSON.stringify(result.payload));return result.payload.data.file.id;
    };
    const productFile=await upload(product,'product'),expenseFile=await upload(expense,'expense');
    await t.test('upload purpose and content remain validated',async()=>{
      for(const [actor,purpose,status] of [[product,'expense',403],[expense,'product',403],[product,null,400],[admin,'other',400]]){
        assert.equal((await request('/api/files',{cookie:actor.cookie,method:'POST',body:png,headers:{'content-type':'image/png',...(purpose?{'x-file-purpose':purpose}:{})}})).status,status);
      }
      const forged=await request('/api/files',{cookie:product.cookie,method:'POST',body:Buffer.from('not png'),headers:{'content-type':'image/png','x-file-purpose':'product'}});
      assert.equal(forged.status,415);assert.equal(forged.payload.error.code,'FILE_CONTENT_MISMATCH');
      const preflight=await request('/api/files',{method:'OPTIONS',headers:{'access-control-request-method':'POST','access-control-request-headers':'content-type,x-file-name,x-file-purpose,x-zenix-client'}});
      assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/x-file-purpose/i);
    });
    await t.test('unlinked files require uploader/admin and correct domain, with tenant-safe errors',async()=>{
      assert.equal((await request(`/api/files/${expenseFile}`,{cookie:product.cookie})).status,403);
      assert.equal((await request(`/api/files/${expenseFile}`,{cookie:expenseReader.cookie})).status,403);
      assert.equal((await request(`/api/files/${expenseFile}`,{cookie:expense.cookie})).status,200);
      assert.equal((await request(`/api/files/${productFile}`,{cookie:productOther.cookie})).status,403);
      assert.equal((await request(`/api/files/${productFile}`,{cookie:admin.cookie})).status,200);
      for(const method of ['GET','DELETE'])assert.equal((await request(`/api/files/${productFile}`,{cookie:foreign.cookie,method})).status,404);
      assert.equal((await request('/api/files/not-uuid',{cookie:admin.cookie})).status,400);
      assert.equal((await request(`/api/files/${productFile}`,{cookie:productOther.cookie,method:'DELETE'})).status,403);
    });
    let productId;
    await t.test('binding enforces purpose, uploader and tenant; legitimate published images remain readable',async()=>{
      const productBody=imageKey=>({name:`File product ${randomUUID()}`,metadata:{imageKey}});
      const mismatch=await request('/api/products',{cookie:product.cookie,method:'POST',body:productBody(expenseFile)});
      assert.equal(mismatch.status,409);assert.equal(mismatch.payload.error.code,'FILE_PURPOSE_MISMATCH');
      assert.equal((await request('/api/products',{cookie:productOther.cookie,method:'POST',body:productBody(productFile)})).status,403);
      assert.equal((await request('/api/products',{cookie:foreign.cookie,method:'POST',body:productBody(productFile)})).status,404);
      const created=await request('/api/products',{cookie:product.cookie,method:'POST',body:productBody(productFile)});
      assert.equal(created.status,201,JSON.stringify(created.payload));productId=created.payload.data.product.id;
      assert.equal((await request(`/api/files/${productFile}`,{cookie:sales.cookie})).status,200);
      assert.equal((await request(`/api/files/${productFile}`,{cookie:expense.cookie})).status,403);
      assert.equal((await request(`/api/products/${productId}`,{cookie:productOther.cookie,method:'PATCH',body:{metadata:{imageKey:productFile,note:'retain existing'}}})).status,200);
      const expenseBody=receiptKey=>({storeId:store,title:'Receipt test',amount:1,paymentMethod:'card',metadata:{receiptKey},clientReference:randomUUID()});
      assert.equal((await request('/api/expenses',{cookie:expense.cookie,method:'POST',body:expenseBody(productFile)})).status,409);
      assert.equal((await request('/api/expenses',{cookie:expense.cookie,method:'POST',body:expenseBody(expenseFile)})).status,201);
      assert.equal((await request(`/api/files/${expenseFile}`,{cookie:expenseReader.cookie})).status,200);
      assert.equal((await request(`/api/files/${expenseFile}`,{cookie:product.cookie})).status,403);
      for(const [id,actor] of [[productFile,product],[expenseFile,expense]])assert.equal((await request(`/api/files/${id}`,{cookie:actor.cookie,method:'DELETE'})).status,409);
    });
    await t.test('legacy purpose is inferred only from existing references, never assigned by default',async()=>{
      async function legacy(){return (await db.query("INSERT INTO file_assets(organization_id,uploaded_by,file_name,mime_type,file_size,content) VALUES($1,$2,'legacy.png','image/png',$3,$4) RETURNING id",[org,product.id,png.length,png])).rows[0].id;}
      const image=await legacy(),receipt=await legacy(),unlinked=await legacy();
      await db.query("INSERT INTO products(organization_id,name,metadata) VALUES($1,'Legacy image',$2)",[org,{imageKey:image}]);
      await db.query("INSERT INTO expenses(organization_id,store_id,title,amount,payment_method,metadata,created_by) VALUES($1,$2,'Legacy receipt',1,'card',$3,$4)",[org,store,{receiptKey:receipt},expense.id]);
      for(const [id,actor,status] of [[image,productOther,200],[image,sales,200],[image,expense,403],[receipt,product,403],[receipt,expenseReader,200],[unlinked,product,200],[unlinked,productOther,403],[unlinked,admin,200]]){
        assert.equal((await request(`/api/files/${id}`,{cookie:actor.cookie})).status,status);
      }
      assert.equal((await db.query('SELECT count(*) FROM file_assets WHERE id=ANY($1::uuid[]) AND purpose IS NOT NULL',[[image,receipt,unlinked]])).rows[0].count,'0');
    });
    await t.test('branch-locked expense permission cannot read, bind or delete another branch receipt',async()=>{
      const first=await account('branch-first',{moduleExpenses:true,expensesWrite:true},org,'CASHIER',store);
      const second=await account('branch-second',{moduleExpenses:true,expensesWrite:true},org,'CASHIER',otherStore);
      for(const purpose of [null,'expense']){
        const id=(await db.query("INSERT INTO file_assets(organization_id,uploaded_by,file_name,mime_type,file_size,content,purpose) VALUES($1,$2,'branch.png','image/png',$3,$4,$5) RETURNING id",[org,first.id,png.length,png,purpose])).rows[0].id;
        await db.query("INSERT INTO expenses(organization_id,store_id,title,amount,payment_method,metadata,created_by) VALUES($1,$2,'Other branch receipt',1,'card',$3,$4)",[org,otherStore,{receiptKey:id},second.id]);
        for(const method of ['GET','DELETE']){
          const denied=await request(`/api/files/${id}`,{cookie:first.cookie,method});
          assert.equal(denied.status,403);assert.equal(denied.payload.error.code,'STORE_FORBIDDEN');
        }
        assert.equal((await request(`/api/files/${id}`,{cookie:second.cookie})).status,200);
        const binding=await request('/api/expenses',{cookie:first.cookie,method:'POST',body:{storeId:store,title:'Cross branch binding',amount:1,paymentMethod:'card',clientReference:randomUUID(),metadata:{receiptKey:id}}});
        assert.equal(binding.status,403);assert.equal(binding.payload.error.code,'STORE_FORBIDDEN');
        // Legacy files referenced by both branches must satisfy every reference scope.
        await db.query("INSERT INTO expenses(organization_id,store_id,title,amount,payment_method,metadata,created_by) VALUES($1,$2,'Shared branch receipt',1,'card',$3,$4)",[org,store,{receiptKey:id},first.id]);
        assert.equal((await request(`/api/files/${id}`,{cookie:second.cookie})).status,403);
        assert.equal((await request(`/api/files/${id}`,{cookie:admin.cookie})).status,200);
      }
    });
    await t.test('file row lock serializes attachment with deletion and prevents a dangling reference',async()=>{
      const id=await upload(product,'product'),client=await db.connect();
      try{
        await client.query('BEGIN');
        // Match application transaction lock order before taking the file lock.
        await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
        await assertFileAssetBinding(client,{user:product.user,id,purpose:'product'});
        const deletion=request(`/api/files/${id}`,{cookie:product.cookie,method:'DELETE'});
        await client.query("INSERT INTO products(organization_id,name,metadata) VALUES($1,'Concurrent file attachment',$2)",[org,{imageKey:id}]);
        await client.query('COMMIT');
        assert.equal((await deletion).status,409);
        assert.equal((await request(`/api/files/${id}`,{cookie:sales.cookie})).status,200);
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      const unused=await upload(product,'product');
      assert.equal((await request(`/api/files/${unused}`,{cookie:product.cookie,method:'DELETE'})).status,200);
      const rejected=await request('/api/products',{cookie:product.cookie,method:'POST',body:{name:'Deleted attachment',metadata:{imageKey:unused}}});
      assert.equal(rejected.status,404);assert.equal(rejected.payload.error.code,'FILE_NOT_FOUND');
    });
    await t.test('waiting binding reloads legacy reference purpose after the competing attachment commits',async()=>{
      const id=(await db.query("INSERT INTO file_assets(organization_id,uploaded_by,file_name,mime_type,file_size,content) VALUES($1,$2,'racing-legacy.png','image/png',$3,$4) RETURNING id",[org,product.id,png.length,png])).rows[0].id;
      const first=await db.connect(),second=await db.connect();let pending;
      try{
        await first.query('BEGIN');await second.query('BEGIN');
        await first.query('SELECT id FROM file_assets WHERE id=$1 FOR UPDATE',[id]);
        const pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        pending=assertFileAssetBinding(second,{user:product.user,id,purpose:'product'}).then(()=>({accepted:true}),error=>({error}));
        let waiting=false;
        const deadline=Date.now()+2000;
        while(Date.now()<deadline){
          const activity=(await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
          if(activity?.wait_event_type==='Lock'){waiting=true;break;}
        }
        assert.equal(waiting,true,'competing bind must actually wait on the file row');
        await first.query("INSERT INTO expenses(organization_id,store_id,title,amount,payment_method,metadata,created_by) VALUES($1,$2,'Concurrent legacy receipt',1,'card',$3,$4)",[org,store,{receiptKey:id},expense.id]);
        await first.query('COMMIT');
        const result=await pending;
        assert.equal(result.error?.code,'FILE_PURPOSE_MISMATCH');
      }finally{
        await first.query('ROLLBACK');await second.query('ROLLBACK');
        if(pending)await pending;
        first.release();second.release();
      }
    });
  }finally{await new Promise(r=>server.close(r));await db.end();await appPool.end();}
});
