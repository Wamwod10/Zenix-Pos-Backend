import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {evaluateProductPromotion} from './productPromotion.js';
const utc=z.string().refine(s=>{if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s))return false;const n=Date.parse(s);return Number.isFinite(n)&&new Date(n).toISOString().replace('.000Z','Z')===s.replace('.000Z','Z')});
const common={id:z.string().uuid(),enabled:z.boolean(),productId:z.string().uuid(),storeIds:z.array(z.string().uuid()).max(100),startsAt:utc,endsAt:utc};
const rule=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('BUY_GET'),buy:z.number().int().min(1).max(1000),free:z.number().int().min(1).max(1000),maxGroups:z.number().int().min(1).max(1000000)}).strict(),
 z.object({...common,kind:z.literal('QUANTITY_PERCENT'),minQuantity:z.number().int().min(1).max(1000000),discountBps:z.number().int().min(1).max(10000)}).strict()
]).superRefine((r,ctx)=>{if(Date.parse(r.startsAt)>=Date.parse(r.endsAt)||new Set(r.storeIds).size!==r.storeIds.length)ctx.addIssue({code:'custom',message:'Aksiya muddati yoki filiallari noto‘g‘ri'})});
export const promotionPolicySchema=z.object({enabled:z.boolean(),rules:z.array(rule).max(200)}).strict().superRefine((p,ctx)=>{if(new Set(p.rules.map(r=>r.id)).size!==p.rules.length)ctx.addIssue({code:'custom',message:'Aksiya ID takrorlangan'})});
export function promotionPolicy(settings){
 const raw=settings?.workspaceSettings?.promotions;
 if(raw?.enabled!==true)return {enabled:false,rules:[]};
 const parsed=promotionPolicySchema.safeParse(raw);
 if(!parsed.success)throw new HttpError(409,'Aksiya sozlamalarini tekshiring','PROMOTION_POLICY_INVALID');
 return parsed.data;
}
export const promotionQuoteSchema=z.object({ruleId:z.string().uuid(),net:z.number().nonnegative()}).strict();
export function catalogPromotion({product,quantity,storeId,settings,now}){
 const policy=promotionPolicy(settings);
 if(!policy.enabled)return null;
 return evaluateProductPromotion({line:{productId:product.id,unit:product.unit,quantity,unitPrice:product.sell_price},rules:policy.rules,storeId,now});
}
export function resolveSalePromotion({product,line,storeId,settings,now,pricing}){
 if(!line.promotionQuote)return pricing;
 if(line.metadata?.packUnit||Number(line.discountPercent)!==0||Number(line.unitPrice)!==Number(product.sell_price))throw new HttpError(409,'Aksiya qo‘lda chegirma yoki qadoq bilan birga ishlamaydi','PROMOTION_PRICE_CONFLICT');
 const quote=catalogPromotion({product,quantity:line.quantity,storeId,settings,now});
 if(!quote||quote.ruleId!==line.promotionQuote.ruleId||quote.net!==line.promotionQuote.net)throw new HttpError(409,'Aksiya o‘zgardi. Savatni yangilang.','PROMOTION_QUOTE_CHANGED');
 const discount=quote.gross?100*quote.discount/quote.gross:0;
 return {...pricing,unitPrice:Number(product.sell_price),gross:quote.gross,lineTotal:quote.net,discountPercent:discount,effectiveDiscount:discount,finalUnitPrice:quote.net/line.quantity,promotion:quote};
}
export async function assertPromotionCatalog(client,organizationId,policy){
 const ids=[...new Set(policy.rules.map(r=>r.productId))];
 const stores=[...new Set(policy.rules.flatMap(r=>r.storeIds))];
 if(ids.length){const {rows}=await client.query('SELECT id FROM products WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND archived=false',[organizationId,ids]);if(rows.length!==ids.length)throw new HttpError(400,'Aksiya mahsuloti topilmadi','PROMOTION_PRODUCT_INVALID')}
 if(stores.length){const {rows}=await client.query('SELECT id FROM stores WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND active=true',[organizationId,stores]);if(rows.length!==stores.length)throw new HttpError(400,'Aksiya filiali topilmadi','PROMOTION_STORE_INVALID')}
}
