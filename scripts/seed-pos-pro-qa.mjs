// Disposable localhost QA data only. Never use a production connection.
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import bcrypt from 'bcryptjs';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
export function assertPosProQaEnvironment(){
 assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
 const parsed=new URL(process.env.TEST_DATABASE_URL);
 if(process.env.NODE_ENV!=='test'||process.env.DATABASE_URL!==process.env.TEST_DATABASE_URL||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))throw Error('QA fixture requires matching loopback test URLs');
}
export async function seedPosProQa(db){
 assertPosProQaEnvironment();
 const suffix=randomUUID().slice(0,8),password=`Qa-only-${suffix}!`,hash=await bcrypt.hash(password,10);
 const org=(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date,store_limit,settings) VALUES($1,'PREMIUM','ACTIVE','2099-01-01',3,$2) RETURNING id",['POS Pro QA '+suffix,{workspaceSettings:{pos:{cashierDiscountAllowed:true,discountLimit:20}}}])).rows[0].id;
 const stores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'QA supermarket'),($1,'QA second branch') RETURNING id",[org])).rows.map(r=>r.id);
 const users={};for(const [key,role,branch] of [['cashier','CASHIER',0],['second','CASHIER',1],['manager','MANAGER',0]]){
  const username=`qa-${key}-${suffix}`;
  const id=(await db.query('INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[org,role==='MANAGER'?null:stores[branch],key,username,hash,role])).rows[0].id;users[key]={id,username,password};
 }
 const definitions=[['Olma','kg',12000,20],['Banan','kg',16000,20],['Guruch','kg',20000,20],['Shakar','g',15,10000],['Sut','l',6000,20],['Suv','ml',2,10000],['Cash exact','dona',127000,20],['Split exact','dona',180000,20],['Credit item','dona',20000,20],['Scan burst','dona',10,1000],['No stock','dona',1000,0],['Low stock','dona',1000,.5],['Same name','dona',1000,20],['Same name','dona',2000,20]];
 while(definitions.length<100)definitions.push([`Food ${definitions.length} ${'long product name '.repeat(definitions.length===99?12:0)}`,'dona',1000+definitions.length,20]);
 const products=[];for(const [i,[name,unit,price,stock]]of definitions.entries()){
  const barcode=i<6?String(123+i).padStart(5,'0'):String(30000000+i),sku='QA-'+i;
  const id=(await db.query('INSERT INTO products(organization_id,name,unit,barcode,sku,sell_price,category) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[org,name,unit,barcode,sku,price,'Food'])).rows[0].id;
  await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,$4)',[org,stores[0],id,stock]);products.push({id,name,unit,price,stock,barcode,sku});
 }
 const customer=(await db.query("INSERT INTO customers(organization_id,name,phone,credit_limit) VALUES($1,'QA Buyer',$2,50000) RETURNING id",[org,suffix])).rows[0].id;
 return {org,stores,users,products,customer};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {pool}=await import('../src/db/pool.js');const db=await pool.connect();
 try{await db.query('BEGIN');const fixture=await seedPosProQa(db);await db.query('COMMIT');console.log(JSON.stringify(fixture,null,2))}
 catch(error){await db.query('ROLLBACK');throw error}finally{db.release();await pool.end()}
}
