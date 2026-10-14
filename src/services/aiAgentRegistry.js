import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {aiReport} from './aiReports.js';
import {authorizeTopic} from './aiPolicy.js';
import {runAgentTool} from './aiAgentTools.js';
import {withTransaction} from '../db/tx.js';
import {recheckAgentActor} from './aiAgentActor.js';

const str={type:'string'},uuid={type:'string',format:'uuid'},nullableUuid={type:['string','null'],format:'uuid'};
const nullableString={type:['string','null']};
const define=(name,description,properties)=>({type:'function',name,description,strict:true,parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export const AGENT_TOOLS=Object.freeze([
 define('search_products','Find authorized products by name or barcode. Multiple matches require user clarification.',{query:str}),
 define('list_locations','List authorized branches and warehouses. Never guess a location.',{}),
 define('get_product_stock','Read verified stock for a known product; null scope uses authorized chat scope.',{productId:uuid,storeId:nullableUuid,warehouseId:nullableUuid}),
 define('get_business_report','Read an existing authorized POS aggregate report. Insufficient history is not evidence of a cause or forecast.',{topic:{type:'string',enum:['today_sales','top_products','profit','expenses','customer_debt','supplier_debt','branches','low_stock','dormant','recommendations']},storeId:nullableUuid}),
 define('prepare_stock_receipt','Prepare a stock receipt preview ONLY. Ask for missing cost/location/tracking information. Never execute or confirm.',{productId:nullableUuid,storeId:nullableUuid,warehouseId:nullableUuid,quantity:{type:['number','null']},unit:nullableString,costPrice:{type:['number','null']},batchNo:nullableString,expiryDate:nullableString}),
]);
export function toolsFor(settings){return AGENT_TOOLS.filter(t=>t.name!=='prepare_stock_receipt'||settings.writesEnabled===true)}
export async function executeAgentTool(user,name,args,context){
 if(!toolsFor(context.settings).some(t=>t.name===name))throw new HttpError(403,'AI amali ruxsat etilmagan','AI_TOOL_FORBIDDEN');
 if(context.storeId&&args?.storeId&&args.storeId!==context.storeId)throw new HttpError(403,'Suhbat filialini o‘zgartirib bo‘lmaydi','STORE_FORBIDDEN');
 if(name==='get_business_report'){
  const input=z.object({topic:z.enum(AGENT_TOOLS.find(t=>t.name===name).parameters.properties.topic.enum),storeId:z.string().uuid().nullable()}).strict().parse(args);
  await withTransaction(db=>recheckAgentActor(db,user));authorizeTopic(user,input.topic);
  return {kind:'report',report:await aiReport(user,input.topic,input.storeId||context.storeId)};
 }
 const scopedArgs={...args};
 if(['get_product_stock','prepare_stock_receipt'].includes(name)&&!scopedArgs.storeId&&context.storeId)scopedArgs.storeId=context.storeId;
 return runAgentTool(user,name,scopedArgs,context);
}
// Keep confirmation secrets outside the model's prompt and persisted context.
export function modelToolResult(value){
 return JSON.parse(JSON.stringify(value,(key,item)=>key==='confirmationToken'?undefined:item));
}
