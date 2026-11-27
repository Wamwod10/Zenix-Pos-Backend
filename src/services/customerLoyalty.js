// Loyalty accrual on confirmed monetary spend; no retrospective accrual. Both operations execute in the existing sale/return
// transaction, protected by its organization/sale locks and replay checks.
const MARKER='ZENIX_AUTO_LOYALTY_V1';
export function loyaltySpendStep(settings){
 const policy=settings?.workspaceSettings?.loyalty;
 if(policy?.enabled!==true)return null;
 const step=policy.spendPerPoint;
 return Number.isSafeInteger(step)&&step>=1000&&step<=1000000?step:null;
}
export async function earnSaleLoyalty(client,{organizationId,saleId,actorId,settings,creditAmount,customerId}){
 const step=loyaltySpendStep(settings);
 if(!step||!customerId||Number(creditAmount)!==0)return;
 // Only a confirmed sale's authoritative net amount and active customer
 // are eligible; never accept point counts or rate from a checkout request.
 await client.query(`INSERT INTO customer_loyalty_ledger(organization_id,customer_id,sale_id,entry_type,points,note,created_by)
 SELECT s.organization_id,s.customer_id,s.id,'EARN',floor((s.total-COALESCE((SELECT sum(p.amount) FROM sale_payments p WHERE p.sale_id=s.id AND p.method='loyalty'),0))/$4::numeric),$5,$3
 FROM sales s JOIN customers c ON c.id=s.customer_id AND c.organization_id=s.organization_id
 WHERE s.organization_id=$1 AND s.id=$2 AND c.archived=false AND s.total-COALESCE((SELECT sum(p.amount) FROM sale_payments p WHERE p.sale_id=s.id AND p.method='loyalty'),0)>=$4::numeric
 AND NOT EXISTS(SELECT 1 FROM customer_loyalty_ledger l WHERE l.organization_id=s.organization_id AND l.sale_id=s.id AND l.entry_type='EARN' AND l.note=$5)`,
 [organizationId,saleId,actorId,step,MARKER]);
}
export async function reverseReturnedLoyalty(client,{organizationId,saleId,actorId,customerId}){
 if(!customerId)return;
 // Use the original earned points, not today's settings. Calculate the target
 // cumulative reversal from the updated returned_amount; differences telescope
 // across partial refunds, and a complete refund reverses exactly all points.
 await client.query(`WITH balance AS (
 SELECT s.organization_id,s.customer_id,s.id,
 floor(COALESCE(sum(l.points) FILTER(WHERE l.entry_type='EARN' AND l.points>0),0)*
 LEAST(s.total-COALESCE(p.amount,0),GREATEST(s.returned_amount-
 CASE WHEN s.total>0 THEN floor(LEAST(s.total,GREATEST(s.returned_amount,0))*COALESCE(p.amount,0)*100/s.total)/100 ELSE 0 END,0))
 /NULLIF(s.total-COALESCE(p.amount,0),0)) target,
 COALESCE(-sum(l.points) FILTER(WHERE l.entry_type='REVERSAL' AND l.points<0),0) reversed
 FROM sales s LEFT JOIN LATERAL (SELECT sum(amount) amount FROM sale_payments WHERE sale_id=s.id AND method='loyalty') p ON true
 JOIN customer_loyalty_ledger l ON l.organization_id=s.organization_id AND l.sale_id=s.id AND l.customer_id=s.customer_id AND l.note=$4
 WHERE s.organization_id=$1 AND s.id=$2 AND s.total>0
 GROUP BY s.organization_id,s.customer_id,s.id,s.total,s.returned_amount,p.amount
 ) INSERT INTO customer_loyalty_ledger(organization_id,customer_id,sale_id,entry_type,points,note,created_by)
 SELECT organization_id,customer_id,id,'REVERSAL',-(target-reversed),$4,$3 FROM balance WHERE target>reversed`,
 [organizationId,saleId,actorId,MARKER]);
}
