import {chromium,expect} from '../../audit-browser-frontend/node_modules/@playwright/test/index.mjs';
import {createServer} from '../../audit-browser-frontend/node_modules/vite/dist/node/index.js';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);if(process.env.NODE_ENV!=='test'||process.env.DATABASE_URL!==process.env.TEST_DATABASE_URL)throw Error('Disposable local database required');
const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
const api=app.listen(0,'127.0.0.1');await new Promise(r=>api.once('listening',r));const backend=`http://127.0.0.1:${api.address().port}`;
const web=await createServer({root:process.env.POS_FRONTEND_ROOT||'../audit-browser-frontend',server:{host:'127.0.0.1',port:0},logLevel:'error'});await web.listen();const base=`http://127.0.0.1:${web.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe':undefined)});
let closing=false,dropped=false;
try{
 const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES($1,'ACTIVE','2099-01-01',2) RETURNING id",['Cost browser '+randomUUID()])).rows[0].id;
 const stores=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Source Browser'),($1,'Destination Browser') RETURNING id",[org])).rows.map(x=>x.id);
 const user=(await pool.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'unused','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
 let token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
 const product=(await pool.query("INSERT INTO products(organization_id,name,unit,sell_price) VALUES($1,'Cost Browser Item','dona',2000) RETURNING id",[org])).rows[0].id;
 await pool.query('UPDATE organizations SET settings=$2::jsonb WHERE id=$1',[org,JSON.stringify({workspaceSettings:{organization:{timezone:'Asia/Tashkent',dateFormat:'DD.MM.YYYY'}}})]);
 const context=await browser.newContext({viewport:{width:1366,height:900},serviceWorkers:'block'});await context.addCookies([{name:'zenix_session',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==base)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();try{if(process.env.TEST_TRANSFER_TIMEOUT==='before'&&!dropped&&u.pathname==='/api/inventory/transfers'&&req.method()==='POST'){dropped=true;return await route.abort()}const res=await route.fetch({url:backend+u.pathname+u.search,headers:{...req.headers(),origin:'http://localhost:5173',cookie:`zenix_session=${token}`}});if(process.env.TEST_TRANSFER_TIMEOUT==='1'&&!dropped&&u.pathname==='/api/inventory/transfers'&&req.method()==='POST'){dropped=true;return await route.abort()}return await route.fulfill({response:res})}catch(error){if(!closing)throw error}});
 await page.goto(base+'/inventory');
 const receive=await page.evaluate(async({store,product})=>{const r=await fetch('/api/inventory/receive',{method:'POST',headers:{'content-type':'application/json','x-zenix-client':'web'},body:JSON.stringify({storeId:store,clientReference:crypto.randomUUID(),lines:[{productId:product,quantity:5,costPrice:1000,sellPrice:2000}]})});return {status:r.status,body:await r.json()}},{store:stores[0],product});if(receive.status!==201)throw Error(JSON.stringify(receive));
 await page.reload();await page.getByRole('button',{name:'Transferlar',exact:true}).click();const builder=page.locator('.transfer-builder');await builder.locator('.premium-select').first().click();await page.getByRole('option',{name:'Destination Browser',exact:true}).click();await builder.locator('.premium-select').nth(1).click();await page.getByRole('option',{name:/Cost Browser Item/}).click();await builder.locator('input[type=number]').fill('2');await builder.getByRole('button',{name:'Qo‘shish'}).click();await builder.getByRole('button',{name:'Transfer yaratish'}).click();
 if(['1','before'].includes(process.env.TEST_TRANSFER_TIMEOUT)){
  await expect(page.getByRole('button',{name:'Transfer natijasini tekshirish'})).toBeVisible();
  await page.reload();await expect(page.getByRole('button',{name:'Transfer natijasini tekshirish'})).toBeVisible();await page.getByRole('button',{name:'Transfer natijasini tekshirish'}).click();
  await expect(page.getByRole('button',{name:'Transfer natijasini tekshirish'})).toHaveCount(0);
  if(Number((await pool.query('SELECT count(*) n FROM stock_transfers WHERE organization_id=$1',[org])).rows[0].n)!==1)throw Error('Transfer retry created duplicates');
 }else await expect(page.locator('body')).toContainText('1 ta mahsulot');
 const transfer=(await pool.query("SELECT id FROM stock_transfers WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1",[org])).rows[0].id;
 const received=await page.evaluate(async id=>{const r=await fetch(`/api/inventory/transfers/${id}/receive`,{method:'POST',headers:{'content-type':'application/json','x-zenix-client':'web'},body:JSON.stringify({items:[]})});return {status:r.status,body:await r.json()}},transfer);if(received.status!==200)throw Error(JSON.stringify(received));
 const balances=(await pool.query('SELECT store_id,quantity,avg_cost,quantity*avg_cost value FROM inventory_balances WHERE organization_id=$1 AND product_id=$2',[org,product])).rows;const dst=balances.find(x=>x.store_id===stores[1]),src=balances.find(x=>x.store_id===stores[0]);if(Number(dst.quantity)!==2||Number(dst.avg_cost)!==1000||Number(dst.value)!==2000||Number(src.quantity)!==3)throw Error(JSON.stringify(balances));
 await page.goto(base);await page.getByRole('button',{name:'Qoldiqni yuklash'}).click();const filter=page.locator('.dashboard-filters .premium-select').last();await filter.click();await page.getByRole('option',{name:'Destination Browser',exact:true}).click();const value=page.locator('.pro-stat').filter({has:page.getByText('Ombor qiymati',{exact:true})}).locator('.pro-stat-copy > strong');await expect(value).toContainText('2,000');if(errors.length)throw Error(JSON.stringify(errors));console.log('PASS: Chromium receipt API -> transfer UI -> receipt API -> PostgreSQL -> dashboard valuation');

 const supplier=(await pool.query("INSERT INTO suppliers(organization_id,name) VALUES($1,'Release supplier') RETURNING id",[org])).rows[0].id;
 await pool.query("INSERT INTO supplier_invoices(organization_id,supplier_id,store_id,invoice_no,total,paid_amount,due_date) VALUES($1,$2,$3,'FINAL-DATE',500,0,'2026-09-30')",[org,supplier,stores[0]]);
 await page.goto(base+'/suppliers');await expect(page.getByRole('heading',{name:'Release supplier',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Batafsil',exact:true}).click();await expect(page.locator('body')).toContainText('30.09.2026');await expect(page.locator('body')).not.toContainText('2026-09-30T');await expect(page.locator('body')).toContainText('FINAL-DATE');
 for(const role of ['OWNER','MANAGER','CASHIER','WAREHOUSE']){
  const actor=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,$3,$4,'unused',$3) RETURNING id",[org,stores[0],role,randomUUID()])).rows[0].id;
  token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[actor,sha256(token)]);
  await context.clearCookies();await context.addCookies([{name:'zenix_session',value:token,url:base,httpOnly:true,sameSite:'Lax'}]);await page.goto(base+'/settings');
  if(role!=='OWNER')await expect(page.locator('body')).toContainText('403');else await expect(page.locator('body')).not.toContainText('403');
  const status=await page.evaluate(async()=>({settings:(await fetch('/api/settings')).status,finance:(await fetch('/api/finance')).status}));
  if(status.settings!==200||status.finance!==(role==='WAREHOUSE'?403:200))throw Error(JSON.stringify({role,status}));
 }
 console.log('PASS: real supplier invoice date and OWNER/MANAGER/CASHIER/WAREHOUSE settings UI/API and finance permission checks; settings bootstrap remains 200 by current contract');
}finally{closing=true;await browser.close();await web.close();api.closeAllConnections();await new Promise(r=>api.close(r));await pool.end()}
