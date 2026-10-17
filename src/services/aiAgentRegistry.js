import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {aiReport} from './aiReports.js';
import {authorizeTopic} from './aiPolicy.js';
import {runAgentTool} from './aiAgentTools.js';
import {withTransaction} from '../db/tx.js';
import {assertAgentEnabled,recheckAgentActor} from './aiAgentActor.js';
import {READ_REPORT_SCHEMAS,readAgentReport} from './aiReadReports.js';

const str={type:'string'},uuid={type:'string',format:'uuid'},nullableUuid={type:['string','null'],format:'uuid'};
const nullableString={type:['string','null']};
const define=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export const AGENT_TOOLS=Object.freeze([
 define('search_products','Find products by name/barcode; clarify duplicates.',{query:str}),
 define('list_locations','List permitted branches/warehouses.',{}),
 define('get_latest_sale','With saleId null read the latest sale across ALL dates, ordered by creation time and ID. For same-cheque follow-ups pass the verified memory sale ID to read that exact sale within permitted scope. Includes at most 50 item rows with truncation flag, exact full total and original payments. Null store uses chat scope.',{storeId:nullableUuid,saleId:nullableUuid}),
 define('get_business_overview','One snapshot for broad business analysis: permitted sales, product profit, expenses, debts and stock; explicit periods.',{storeId:nullableUuid}),
 define('get_product_stock','Read a known product stock; null uses chat scope.',{productId:uuid,storeId:nullableUuid,warehouseId:nullableUuid}),
 define('get_business_report','Read permitted POS facts; no causal inference.',{topic:{type:'string',enum:['today_sales','top_products','profit','expenses','customer_debt','supplier_debt','branches','low_stock','dormant','recommendations']},storeId:nullableUuid}),
 define('get_warehouse_summary','Catalog, available, low-stock counts are distinct.',{storeId:nullableUuid}),
 define('get_restock_advice','Read-only 7-day restock heuristic from 28 business dates of net product sales and active stock. Null quantity means insufficient history or unknown unit; never creates purchases.',{storeId:nullableUuid}),
 define('compare_sales_periods','Compare inclusive business dates, <=366 days each; net of dated returns.',{storeId:nullableUuid,from:{type:'string',format:'date'},to:{type:'string',format:'date'},comparisonFrom:{type:'string',format:'date'},comparisonTo:{type:'string',format:'date'}}),
 define('get_product_sales_report','Top/slow net revenue; paired null dates mean last 7 business days.',{storeId:nullableUuid,ranking:{type:'string',enum:['top','slow']},from:{type:['string','null'],format:'date'},to:{type:['string','null'],format:'date'}}),
 define('prepare_stock_receipt','Preview only; ask missing cost/location/batch. Never execute.',{productId:nullableUuid,storeId:nullableUuid,warehouseId:nullableUuid,quantity:{type:['number','null']},unit:nullableString,costPrice:{type:['number','null']},batchNo:nullableString,expiryDate:nullableString}),
]);
export function toolsFor(settings){return AGENT_TOOLS.filter(t=>t.name!=='prepare_stock_receipt'||settings.writesEnabled===true)}
export async function executeAgentTool(user,name,args,context){
 assertAgentEnabled(context.settings);
 if(!toolsFor(context.settings).some(t=>t.name===name))throw new HttpError(403,'AI amali ruxsat etilmagan','AI_TOOL_FORBIDDEN');
 if(context.storeId&&args?.storeId&&args.storeId!==context.storeId)throw new HttpError(403,'Suhbat filialini o‘zgartirib bo‘lmaydi','STORE_FORBIDDEN');
 if(name==='get_business_report'){
  const input=z.object({topic:z.enum(AGENT_TOOLS.find(t=>t.name===name).parameters.properties.topic.enum),storeId:z.string().uuid().nullable()}).strict().parse(args);
  return withTransaction(async db=>{const current=await recheckAgentActor(db,user);authorizeTopic(current,input.topic);
   return {kind:'report',report:await aiReport(current,input.topic,input.storeId||context.storeId,db)};
  });
 }
 if(READ_REPORT_SCHEMAS[name]){
  const input=READ_REPORT_SCHEMAS[name].parse(args);
  return withTransaction(async db=>{const current=await recheckAgentActor(db,user);await db.query("SET LOCAL statement_timeout='2000ms'");
   return {kind:'report',report:await readAgentReport(db,current,name,{...input,storeId:input.storeId||context.storeId||null})};
  },{isolationLevel:'repeatable read'});
 }
 const scopedArgs={...args};
 if(['get_product_stock','prepare_stock_receipt'].includes(name)&&!scopedArgs.storeId&&context.storeId)scopedArgs.storeId=context.storeId;
 return runAgentTool(user,name,scopedArgs,context);
}
// Keep confirmation secrets outside the model's prompt and persisted context.
export function modelToolResult(value){
 return JSON.parse(JSON.stringify(value,(key,item)=>key==='confirmationToken'?undefined:item));
}
