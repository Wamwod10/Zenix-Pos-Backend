import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {hasPermission} from '../lib/permissions.js';
import {assertStoreScope,assertOrganizationStore} from '../lib/storeScope.js';
export function validatePosProPayment(input){
 if(input.metadata?.source!=='pos-pro')return;
 if(input.payments.some(p=>['card','transfer'].includes(p.method)&&p.amount>0)&&input.metadata.externalPaymentConfirmation!=='manual-confirmed')throw new HttpError(409,'Tashqi to‘lovni qo‘lda tasdiqlang','EXTERNAL_PAYMENT_UNCONFIRMED');
 const cash=input.payments.filter(p=>p.method==='cash').reduce((s,p)=>s+Number(p.amount),0),tendered=input.metadata.cashTendered;
 if(cash>0&&(!Number.isFinite(tendered)||tendered<cash||tendered>9000000000000||Math.abs(tendered*100-Math.round(tendered*100))>0.00001))throw new HttpError(400,'Naqd summa noto‘g‘ri','INVALID_CASH_TENDERED');
}
export async function readPosProSummary(client,user,query){
 if(!hasPermission(user,'moduleSales'))throw new HttpError(403,'POS access denied','FORBIDDEN');
 const {storeId,shiftId}=z.object({storeId:z.string().uuid(),shiftId:z.string().uuid().optional()}).strict().parse(query);
 assertStoreScope(user,storeId);await assertOrganizationStore(client,user.organizationId,storeId);
 const shift=(await client.query("SELECT id,status,cashier_id FROM shifts WHERE organization_id=$1 AND store_id=$2 AND status='open' AND ($3::uuid IS NULL OR id=$3) ORDER BY opened_at DESC LIMIT 1",[user.organizationId,storeId,shiftId||null])).rows[0];
 if(!shift)return {shift:null,count:0,total:0,cash:0,card:0,transfer:0,recent:[],popular:[]};
 // A single SQL statement gives mutually consistent aggregate and recent-sale snapshots.
 const row=(await client.query(`WITH scoped AS (
  SELECT id,total,sale_number,created_at FROM sales WHERE organization_id=$1 AND store_id=$2 AND shift_id=$3
 ), pay AS (SELECT sp.method,sum(sp.amount) amount FROM sale_payments sp JOIN scoped s ON s.id=sp.sale_id GROUP BY sp.method),
 refunds AS (SELECT COALESCE(sum(r.amount),0) total,
  COALESCE(sum(COALESCE((r.metadata->'refundBreakdown'->>'cash')::numeric,0)),0) cash,
  COALESCE(sum(COALESCE((r.metadata->'refundBreakdown'->>'card')::numeric,0)),0) card,
  COALESCE(sum(COALESCE((r.metadata->'refundBreakdown'->>'transfer')::numeric,0)),0) transfer
  FROM sale_returns r JOIN sales original ON original.id=r.sale_id AND original.organization_id=r.organization_id
  WHERE r.organization_id=$1 AND r.store_id=$2 AND COALESCE(NULLIF(r.metadata->>'refundShiftId','')::uuid,original.shift_id)=$3)
 SELECT (SELECT count(*)::int FROM scoped) count,
 COALESCE((SELECT sum(total) FROM scoped),0)-(SELECT total FROM refunds) total,
 COALESCE((SELECT amount FROM pay WHERE method='cash'),0)-(SELECT cash FROM refunds) cash,
 COALESCE((SELECT amount FROM pay WHERE method='card'),0)-(SELECT card FROM refunds) card,
 COALESCE((SELECT amount FROM pay WHERE method='transfer'),0)-(SELECT transfer FROM refunds) transfer,
 COALESCE((SELECT jsonb_agg(r) FROM (SELECT * FROM scoped ORDER BY created_at DESC LIMIT 5) r),'[]'::jsonb) recent,
 COALESCE((SELECT jsonb_agg(r) FROM (SELECT si.product_id,sum(si.quantity) quantity FROM sale_items si JOIN scoped s ON s.id=si.sale_id GROUP BY si.product_id ORDER BY sum(si.quantity) DESC LIMIT 12) r),'[]'::jsonb) popular`,[user.organizationId,storeId,shift.id])).rows[0];
 return {...row,shift,...Object.fromEntries(['count','total','cash','card','transfer'].map(k=>[k,Number(row?.[k]||0)]))};
}
