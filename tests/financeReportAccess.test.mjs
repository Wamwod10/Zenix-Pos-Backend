import test from 'node:test';
import assert from 'node:assert/strict';
import * as access from '../src/services/financeReportAccess.js';
const report={aggregate:{netRevenue:100,grossProfit:70,expenseTotal:20,netProfit:50},sales:[],returns:[],expenses:[{title:'Private payroll',amount:20}],pagination:{limit:10,offset:0,total:1,returnTotal:0,expenseTotal:50,hasMore:true}};
test('history-only readers receive no expense records, amounts, profit, or pagination side channel',()=>{
  assert.equal(typeof access.financeExpenseAccess,'function');
  const permissions=access.financeExpenseAccess({appRole:'CASHIER'});
  assert.deepEqual(permissions,{details:false,aggregate:false});
  const result=access.scopeFinanceExpenses(report,permissions);
  assert.equal(Object.hasOwn(result,'expenses'),false);
  for(const key of ['expenseTotal','netProfit'])assert.equal(Object.hasOwn(result.aggregate,key),false);
  assert.equal(Object.hasOwn(result.pagination,'expenseTotal'),false);
  assert.equal(result.pagination.hasMore,false);
  assert.equal(result.aggregate.grossProfit,70);
  assert.equal(report.expenses.length,1,'source report must remain unchanged');
});
test('analytics custom grant permits aggregate only; moduleExpenses explicit grant permits details',()=>{
  assert.equal(typeof access.financeExpenseAccess,'function');
  const analytics=access.financeExpenseAccess({appRole:'CASHIER',permissionOverrides:{analytics:true}});
  assert.deepEqual(analytics,{details:false,aggregate:true});
  const result=access.scopeFinanceExpenses(report,analytics);
  assert.equal(result.aggregate.netProfit,50);assert.equal(Object.hasOwn(result,'expenses'),false);
  const expenses=access.financeExpenseAccess({appRole:'CASHIER',permissionOverrides:{moduleExpenses:true}});
  assert.deepEqual(expenses,{details:true,aggregate:true});
  assert.deepEqual(access.scopeFinanceExpenses(report,expenses),report);
});
for(const role of ['OWNER','ADMIN','MANAGER'])test(`${role} normal finance output stays complete`,()=>{
  assert.equal(typeof access.financeExpenseAccess,'function');
  assert.deepEqual(access.scopeFinanceExpenses(report,access.financeExpenseAccess({appRole:role})),report);
});
test('explicit analytics and expense denials override manager defaults',()=>{
  assert.equal(typeof access.financeExpenseAccess,'function');
  assert.deepEqual(access.financeExpenseAccess({appRole:'MANAGER',permissionOverrides:{moduleExpenses:false,analytics:false}}),{details:false,aggregate:false});
});

import {financeReport} from '../src/services/financeReport.js';
test('history-only report does not query expenses, analytics grant queries totals only',async()=>{
  for(const [permissions,queries] of [[{details:false,aggregate:false},0],[{details:false,aggregate:true},1]]){
    const calls=[];
    const db={query:async sql=>{
      calls.push(sql);
      return {rows:/SELECT jsonb_build_object|SELECT r\.\*|SELECT sp\.method/.test(sql)?[]:[{}]};
    }};
    const result=await financeReport(db,{organizationId:'org',expenseAccess:permissions});
    assert.equal(calls.filter(sql=>sql.includes('FROM expenses')).length,queries);
    assert.equal(calls.some(sql=>sql.includes('SELECT e.*')),false);
    assert.equal(Object.hasOwn(result,'expenses'),false);
    assert.equal(Object.hasOwn(result.aggregate,'expenseTotal'),permissions.aggregate);
  }
});
