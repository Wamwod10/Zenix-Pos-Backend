import { HttpError } from './http.js';

export async function shiftExpectedCash(client,shift){
  if(!shift?.id)return 0;
  const cashSales=Number((await client.query(`
    SELECT COALESCE(sum(sp.amount),0) amount
    FROM sale_payments sp
    JOIN sales s ON s.id=sp.sale_id
    WHERE s.shift_id=$1 AND sp.method='cash'`,[shift.id])).rows[0]?.amount||0);
  const movements=Number((await client.query(`
    SELECT COALESCE(sum(CASE WHEN type='in' THEN amount ELSE -amount END),0) amount
    FROM shift_movements WHERE shift_id=$1`,[shift.id])).rows[0]?.amount||0);
  return Number(shift.opening_cash||0)+cashSales+movements;
}

export async function assertShiftCashAvailable(client,shift,amount,{message="Kassada yetarli naqd pul yo‘q"}={}){
  const requested=Math.max(0,Number(amount||0));
  const available=await shiftExpectedCash(client,shift);
  if(requested-available>0.01)throw new HttpError(409,message,"INSUFFICIENT_REGISTER_CASH",{available,requested});
  return available;
}
