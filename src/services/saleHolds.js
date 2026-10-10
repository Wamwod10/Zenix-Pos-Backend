import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {lineAmount,sumMoney} from '../lib/posMoney.js';
const quantity=z.coerce.number().positive().max(999999999).refine(value=>Math.abs(value*1000-Math.round(value*1000))<0.00001,'Miqdor 3 kasr belgidan oshmasin');
const line=z.object({id:z.string().uuid('Mahsulot ID noto‘g‘ri'),cartQty:quantity,sellPrice:z.coerce.number().min(0).max(9000000000000).default(0),discountPercent:z.coerce.number().min(0).max(100).default(0),name:z.string().max(300).optional(),tracking:z.record(z.string(),z.any()).optional()});
export const holdSchema=z.object({
 storeId:z.string().uuid('Filial ID noto‘g‘ri'),shiftId:z.preprocess(value=>value===''?null:value,z.string().uuid('Smena ID noto‘g‘ri').nullable().optional()),
 name:z.string().trim().min(1).max(120),cart:z.array(line).min(1).max(250).refine(lines=>new Set(lines.map(item=>item.id)).size===lines.length,'Takroriy mahsulot'),
 customer:z.string().max(300).default(''),customerId:z.preprocess(value=>value===''?null:value,z.string().uuid().nullable().optional()),note:z.string().max(1000).default(''),
 cartDiscountPct:z.coerce.number().min(0).max(100).default(0),total:z.coerce.number().min(0).default(0),clientReference:z.string().trim().max(120).default(''),
});
export const holdView=row=>({id:row.id,storeId:row.store_id,shiftId:row.shift_id||'',name:row.name,cart:Array.isArray(row.cart)?row.cart:[],customer:row.customer||'',customerId:row.customer_id||'',note:row.note||'',cartDiscountPct:Number(row.cart_discount_percent||0),total:Number(row.total||0),clientReference:row.client_reference||'',createdAt:row.created_at});
export const holdIntent=input=>({name:input.name,cart:input.cart.map(({id,cartQty,sellPrice,discountPercent,tracking})=>({id,cartQty,sellPrice,discountPercent,tracking})),customer:input.customer||'',customerId:input.customerId||'',note:input.note||'',cartDiscountPct:Number(input.cartDiscountPct||0)});
export async function validateHoldCatalog(client,organizationId,input){
 const products=(await client.query('SELECT id,name,sell_price FROM products WHERE organization_id=$1 AND archived=false AND id=ANY($2::uuid[])',[organizationId,input.cart.map(item=>item.id)])).rows;
 const byId=new Map(products.map(item=>[item.id,item]));
 if(products.length!==input.cart.length)throw new HttpError(409,'Savatda arxivlangan yoki boshqa biznes mahsuloti bor','HOLD_PRODUCT_UNAVAILABLE');
 if(input.customerId&&!((await client.query('SELECT id FROM customers WHERE id=$1 AND organization_id=$2 AND archived=false',[input.customerId,organizationId])).rows[0]))throw new HttpError(409,'Mijoz topilmadi','CUSTOMER_NOT_FOUND');
 return {...input,cart:input.cart.map(item=>({...item,name:byId.get(item.id).name})),total:sumMoney(input.cart.map(item=>lineAmount(item.cartQty,item.sellPrice,(1-(1-item.discountPercent/100)*(1-input.cartDiscountPct/100))*100)))};
}
