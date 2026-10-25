import { HttpError } from '../lib/http.js';
import { hasPermission } from '../lib/permissions.js';
import { assertOrganizationStore, assertStoreScope } from '../lib/storeScope.js';
import { assertSharedOpenShift } from '../lib/branchShift.js';
import { sumMoney } from '../lib/posMoney.js';
import { requestFingerprint } from './posReplay.js';
import { lockStoreTradingAuthorization } from './storeTradingHolds.js';
import { writeAudit } from './audit.js';

// The caller must supply one transaction for replay, ledger, allocation and cash.
export async function recordCustomerRepayment(client, { user, customerId, input, storeId }) {
  if(!input.clientReference?.trim())throw new HttpError(400,'Repayment requires a client reference','CLIENT_REFERENCE_REQUIRED');
  const organizationId=user.organizationId;
  const cash=input.paymentMethod==='cash';
  const fingerprint=requestFingerprint({customerId,userId:user.id,...input,storeId});
  // Completed retries remain valid after the shift closes; never create another movement.
  if(input.clientReference){
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-payment:${organizationId}:${input.clientReference}`]);
    const previous=(await client.query("SELECT * FROM customer_ledger WHERE organization_id=$1 AND entry_type='PAYMENT' AND metadata->>'clientReference'=$2",[organizationId,input.clientReference])).rows[0];
    if(previous){
      if(previous.customer_id!==customerId||previous.metadata?.fingerprint!==fingerprint)throw new HttpError(409,'Payment reference conflict','IDEMPOTENCY_CONFLICT');
      return previous;
    }
  }
  let shift=null;
  if(cash){
    if(!input.shiftId)throw new HttpError(400,'Cash repayment requires a shift','SHIFT_REQUIRED');
    assertStoreScope(user,storeId);
    if(!hasPermission(user,'moduleShifts'))throw new HttpError(403,'Shift permission required','FORBIDDEN');
    // Use the same organization -> shift -> customer order as trading and closing.
    await lockStoreTradingAuthorization(client,{organizationId,storeId});
    shift=(await client.query('SELECT * FROM shifts WHERE organization_id=$1 AND id=$2 FOR UPDATE',[organizationId,input.shiftId])).rows[0];
    assertSharedOpenShift(shift,{organizationId,storeId});
    if(!hasPermission(user,'shiftRecon')&&String(shift.cashier_id)!==String(user.id))throw new HttpError(403,'Cannot control another cashier shift','SHIFT_FORBIDDEN');
    const register=(await client.query('SELECT * FROM pos_registers WHERE organization_id=$1 AND store_id=$2 AND id=$3',[organizationId,storeId,shift.register_id])).rows[0];
    if(!register?.active||register.register_key!==shift.register_key)throw new HttpError(409,'Active scoped POS register required','REGISTER_INACTIVE');
  }
  if(storeId)await assertOrganizationStore(client,organizationId,storeId);
  const customer=(await client.query('SELECT * FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE',[customerId,organizationId])).rows[0];
  if(!customer)throw new HttpError(404,'Customer not found');
  const balance=Number((await client.query('SELECT COALESCE(sum(amount),0) balance FROM customer_ledger WHERE organization_id=$1 AND customer_id=$2',[organizationId,customer.id])).rows[0].balance||0);
  if(input.amount>balance)throw new HttpError(409,'Payment exceeds customer balance','CUSTOMER_PAYMENT_EXCEEDS_BALANCE',{balance});
  const row=(await client.query(`INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount,payment_method,note,created_by,metadata,shift_id,register_id,repayment_client_reference)
    VALUES($1,$2,$3,'PAYMENT',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[organizationId,customer.id,storeId,-input.amount,input.paymentMethod,input.note,user.id,{clientReference:input.clientReference,fingerprint},shift?.id||null,shift?.register_id||null,input.clientReference||null])).rows[0];
  let remaining=input.amount;
  const credits=(await client.query(`SELECT cl.id,GREATEST(cl.amount-COALESCE(sum(a.amount),0),0) open_amount FROM customer_ledger cl LEFT JOIN customer_payment_allocations a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.customer_id=$2 AND cl.entry_type='CREDIT_SALE' GROUP BY cl.id ORDER BY cl.due_date NULLS LAST,cl.created_at,cl.id`,[organizationId,customer.id])).rows;
  for(const credit of credits){
    if(remaining<=0)break;
    const amount=Math.min(remaining,Number(credit.open_amount||0));
    if(amount<=0)continue;
    await client.query('INSERT INTO customer_payment_allocations(organization_id,customer_id,payment_ledger_id,credit_ledger_id,amount) VALUES($1,$2,$3,$4,$5)',[organizationId,customer.id,row.id,credit.id,amount]);
    remaining=sumMoney([remaining,-amount]);
  }
  if(cash)await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by,customer_payment_ledger_id)
    VALUES($1,$2,'in',$3,$4,'customer_payment',($5::uuid)::text,$6,$5::uuid)`,[organizationId,shift.id,input.amount,'Customer debt repayment',row.id,user.id]);
  await writeAudit(client,{organizationId,userId:user.id,storeId,action:'create',entityType:'customer_payment',entityId:row.id,title:'Customer repayment received',description:`${customer.name} · ${input.amount}`,after:cash?{shiftId:shift.id,registerId:shift.register_id}:null});
  return row;
}
