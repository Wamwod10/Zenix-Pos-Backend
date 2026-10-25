import {hasPermission} from '../lib/permissions.js';

export function financeExpenseAccess(user){
  const details=hasPermission(user,'moduleExpenses');
  return {details,aggregate:details||hasPermission(user,'analytics')};
}

export function scopeFinanceExpenses(report,{details=true,aggregate=true}={}){
  const result={...report,aggregate:{...report.aggregate},pagination:{...report.pagination}};
  if(!details){
    delete result.expenses;
    delete result.pagination.expenseTotal;
    result.pagination.hasMore=result.pagination.offset+result.pagination.limit<Math.max(result.pagination.total,result.pagination.returnTotal);
  }
  if(!aggregate){delete result.aggregate.expenseTotal;delete result.aggregate.netProfit}
  return result;
}
