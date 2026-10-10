import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {organizationPageSchema,paymentPageSchema,organizationPageSql,paymentPageSql,fetchDirectoryPage,likeTerm,effectiveLicenseStatusSql} from '../src/services/platformDirectory.js';

test('platform directory paging enforces bounded validated searches and statuses',()=>{
  assert.deepEqual(organizationPageSchema.parse({}),{q:'',status:'all',limit:20,offset:0});
  assert.equal(organizationPageSchema.safeParse({limit:'101'}).success,false);
  assert.equal(organizationPageSchema.safeParse({limit:'0'}).success,false);
  assert.equal(organizationPageSchema.safeParse({offset:'-1'}).success,false);
  assert.equal(organizationPageSchema.safeParse({q:'a'.repeat(101)}).success,false);
  assert.equal(organizationPageSchema.safeParse({status:'APPROVED'}).success,false);
  assert.equal(paymentPageSchema.safeParse({status:'SUSPENDED'}).success,false);
  assert.equal(paymentPageSchema.parse({status:'REVIEW'}).status,'REVIEW');
});

test('directory search treats SQL wildcard metacharacters as literal characters',()=>{
  assert.equal(likeTerm('a%b_c\\d'),'%a\\%b\\_c\\\\d%');
  const input=organizationPageSchema.parse({q:"O'Reilly_%",status:'ACTIVE',limit:'20',offset:'40'});
  const query=organizationPageSql(input);
  assert.deepEqual(query.rowsParams,["%O'Reilly\\_\\%%",'ACTIVE',20,40]);
  assert.match(query.rowsSql,/ESCAPE/);
  assert.doesNotMatch(query.rowsSql,/O'Reilly/);
});

test('payment and organization directory pages use separate stable ordering',()=>{
  const org=organizationPageSql(organizationPageSchema.parse({}));
  const pay=paymentPageSql(paymentPageSchema.parse({}));
  assert.match(org.rowsSql,/ORDER BY o.created_at DESC,o.id DESC LIMIT \$3 OFFSET \$4/);
  assert.match(pay.rowsSql,/ORDER BY bp.submitted_at DESC,bp.id DESC LIMIT \$3 OFFSET \$4/);
  assert.match(org.countSql,/count\(\*\)::int AS total/);
  assert.match(pay.countSql,/count\(\*\)::int AS total/);
});

test('platform paging executes parameterized bounded queries and returns total',async()=>{
  const queries=[];
  const db={query:async(sql,args)=>{queries.push([sql,args]);return sql.includes('AS total')?{rows:[{total:5000}]}:{rows:[{id:'one'}]}}};
  const result=await fetchDirectoryPage(db,organizationPageSql(organizationPageSchema.parse({q:'Market',limit:'10',offset:'30'})));
  assert.deepEqual(result,{rows:[{id:'one'}],total:5000});
  assert.equal(queries.length,2);
  assert.equal(queries[0][1][2],10);
  assert.equal(queries[0][1][3],30);
});

test('platform organization page selects the settings consumed by list and detail views',()=>{
  const query=organizationPageSql(organizationPageSchema.parse({}));
  assert.match(query.rowsSql,/SELECT[\s\S]*\bo\.settings\b[\s\S]*FROM organizations o/);
});

test('platform endpoints require platform admin and lazy-load a single tenant detail',()=>{
  const src=readFileSync(new URL('../src/routes/platform.js',import.meta.url),'utf8');
  assert.match(src,/router\.use\(requireAuth,requirePermission\("platformAdmin"\)\)/);
  assert.match(src,/router\.get\("\/overview"/);
  assert.match(src,/router\.get\("\/organizations\/page"/);
  assert.match(src,/router\.get\("\/payments\/page"/);
  assert.match(src,/router\.get\("\/organizations\/:id\/detail"/);
  assert.match(src,/FROM users WHERE organization_id=\$1 ORDER BY created_at DESC LIMIT 100/);
  assert.match(src,/WHERE bp.organization_id=\$1/);
});

test('platform license statistics and filters use effective expiry in tenant timezone',()=>{
  const expression=effectiveLicenseStatusSql();
  assert.match(expression,/license_status IN \('ACTIVE','APPROVED'\)/);
  assert.match(expression,/expiry_date < \(now\(\) AT TIME ZONE COALESCE/);
  assert.match(expression,/THEN 'EXPIRED'/);
  const query=organizationPageSql(organizationPageSchema.parse({status:'EXPIRED'}));
  assert.ok(query.countSql.includes(expression));
  assert.ok(query.rowsSql.includes(`${expression} AS license_status`));
  const platform=readFileSync(new URL('../src/routes/platform.js',import.meta.url),'utf8');
  assert.match(platform,/effectiveLicenseStatusSql\(\)/);
  assert.match(platform,/effective_license_status/);
  assert.match(platform,/FILTER \(WHERE \(\$\{effectiveStatus\}\) IN \('ACTIVE','APPROVED'\) AND COALESCE\(o.settings->>'billingHold','false'\)<>'true'\)/);
});
