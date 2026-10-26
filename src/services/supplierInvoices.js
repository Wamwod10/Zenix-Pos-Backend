import {HttpError} from '../lib/http.js';
import {assertOrganizationStore} from '../lib/storeScope.js';
import {sumMoney} from '../lib/posMoney.js';
import {financialWriteReplay} from './financialWriteReplay.js';
import {writeAudit} from './audit.js';
import {enqueueNotification} from './notifications.js';

// Caller supplies the transaction. Initial settlements retain their existing
// external-payment semantics; this operation never withdraws register cash.
export function createSupplierInvoice(client,{user,supplierId,input,storeId}){
  if(!input.clientReference?.trim())throw new HttpError(400,'Invoice requires a client reference','CLIENT_REFERENCE_REQUIRED');
  const organizationId=user.organizationId;
  return financialWriteReplay(client,{organizationId,userId:user.id,operation:'supplier_invoice_create',clientReference:input.clientReference,
    input:{supplierId,...input,storeId}},async()=>{
    const store=storeId?await assertOrganizationStore(client,organizationId,storeId):null;
    const supplier=(await client.query('SELECT * FROM suppliers WHERE id=$1 AND organization_id=$2 AND archived=false FOR UPDATE',[supplierId,organizationId])).rows[0];
    if(!supplier)throw new HttpError(404,'Supplier not found');
    const row=(await client.query(`INSERT INTO supplier_invoices(organization_id,supplier_id,store_id,invoice_no,total,paid_amount,due_date)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[organizationId,supplier.id,storeId||null,input.invoiceNo,input.total,input.paidAmount,input.dueDate||null])).rows[0];
    if(input.paidAmount>0)await client.query(`INSERT INTO supplier_payments(organization_id,supplier_id,invoice_id,store_id,amount,method,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'Initial invoice settlement',$7)`,[organizationId,supplier.id,row.id,storeId||null,input.paidAmount,input.paymentMethod,user.id]);
    await writeAudit(client,{organizationId,userId:user.id,storeId:storeId||null,action:'create',entityType:'supplier_invoice',entityId:row.id,title:'Supplier invoice created',description:`${supplier.name} · ${input.total}`});
    const debt=sumMoney([input.total,-input.paidAmount]);
    if(debt>0)await enqueueNotification(client,{organizationId,storeId:storeId||null,eventType:'supplier.debt',eventId:row.id,payload:{supplierName:supplier.name,invoiceNo:input.invoiceNo||'',debt,dueDate:input.dueDate||'',storeName:store?.name||''}});
    return row;
  });
}
