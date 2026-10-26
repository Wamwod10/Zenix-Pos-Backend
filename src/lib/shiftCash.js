import { HttpError } from './http.js';
import { sumMoney } from './posMoney.js';

export async function shiftCashSummary(client,shift){
  if(!shift?.id)return {openingCash:0,cashSales:0,cashIn:0,cashOut:0,expectedCash:0};
  // One statement gives all components the same PostgreSQL snapshot. Aggregate
  // payments and movements separately so joining them cannot multiply amounts.
  const row=(await client.query(`
    SELECT
      (SELECT COALESCE(sum(sp.amount),0) FROM sale_payments sp
       JOIN sales s ON s.id=sp.sale_id
       WHERE s.shift_id=$1 AND s.organization_id=$2 AND sp.method='cash') cash_sales,
      (SELECT COALESCE(sum(amount) FILTER (WHERE type='in'),0)
       FROM shift_movements WHERE shift_id=$1 AND organization_id=$2) cash_in,
      (SELECT COALESCE(sum(amount) FILTER (WHERE type='out'),0)
       FROM shift_movements WHERE shift_id=$1 AND organization_id=$2) cash_out`,[shift.id,shift.organization_id])).rows[0];
  const openingCash=sumMoney([shift.opening_cash||0]);
  const cashSales=sumMoney([row?.cash_sales||0]);
  const cashIn=sumMoney([row?.cash_in||0]);
  const cashOut=sumMoney([row?.cash_out||0]);
  return {openingCash,cashSales,cashIn,cashOut,expectedCash:sumMoney([openingCash,cashSales,cashIn,-cashOut])};
}

export async function shiftExpectedCash(client,shift){
  return (await shiftCashSummary(client,shift)).expectedCash;
}

export async function assertShiftCashAvailable(client,shift,amount,{message="Kassada yetarli naqd pul yo‘q"}={}){
  const requested=Math.max(0,Number(amount||0));
  const available=await shiftExpectedCash(client,shift);
  if(requested-available>0.01)throw new HttpError(409,message,"INSUFFICIENT_REGISTER_CASH",{available,requested});
  return available;
}
