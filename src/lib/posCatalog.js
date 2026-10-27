import {z} from 'zod';
import {exactDecimalNumber} from './posMoney.js';
const decimalMap=value=>Object.fromEntries(Object.entries(value||{}).map(([key,n])=>[key,exactDecimalNumber(n)]));
import {HttpError} from './http.js';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const posCatalogQuerySchema=z.object({
 storeId:uuid,limit:z.coerce.number().int().min(1).max(100).default(50),
 search:z.string().trim().max(120).default(''),barcode:z.string().trim().max(120).default(''),category:z.string().trim().max(120).default(''),
 ids:z.string().max(3699).transform(value=>value.split(',')).pipe(z.array(uuid).min(1).max(100)).transform(ids=>[...new Set(ids)]).optional(),
 cursor:z.string().min(1).max(512).optional(),
}).strict().superRefine((value,ctx)=>{
 if((value.ids&&(value.search||value.barcode||value.category||value.cursor))||(value.barcode&&(value.search||value.category||value.cursor)))ctx.addIssue({code:'custom',message:'Lookup modes cannot be combined'});
});
const cursorSchema=z.object({createdAt:z.string().datetime({offset:true}),id:uuid}).strict();
export function encodePosCatalogCursor(row){return Buffer.from(JSON.stringify({createdAt:row.cursor_created_at,id:row.id})).toString('base64url')}
export function decodePosCatalogCursor(value){
 if(!value)return null;
 try{if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length>512)throw Error();return cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString()))}
 catch{throw new HttpError(400,'Invalid catalog cursor','INVALID_CATALOG_CURSOR')}
}
export const mapBootstrapProduct=(row)=>({
 ...(row.metadata||{}),id:row.id,name:row.name,sku:row.sku,barcode:row.barcode,category:row.category,brand:row.brand,unit:row.unit,
 costPrice:exactDecimalNumber(row.cost_price||0),sellPrice:exactDecimalNumber(row.sell_price||0),price:exactDecimalNumber(row.sell_price||0),wholesalePrice:exactDecimalNumber(row.wholesale_price||0),minStock:exactDecimalNumber(row.min_stock||0),archived:row.archived,
 stockByStore:decimalMap(row.stock_by_store),costByStore:decimalMap(row.cost_by_store),lastSaleAt:row.last_sale_at||null,metadata:row.metadata||{},
});
