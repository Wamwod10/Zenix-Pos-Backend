import {createHash} from 'node:crypto';
import {HttpError} from './http.js';
import {validThermalLogo} from './thermalLogo.js';
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function canonical(v){
 if(Array.isArray(v))return v.map(canonical);
 if(record(v))return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));
 return v;
}
// Exclude unrelated licensing/Telegram metadata from the concurrency token.
export function settingsRevision(row={}){
 const s=row.settings||{};
 return createHash('sha256').update(JSON.stringify(canonical({
  organization:[row.name??null,row.phone??null,row.address??null,row.timezone??null,row.currency??null],
  workspaceSettings:s.workspaceSettings||{},businessFeatures:s.businessFeatures||{},rolePermissions:s.rolePermissions||{}
 }))).digest('hex');
}
export function assertSettingsRevision(expected,row){
 if(expected!==undefined&&expected!==settingsRevision(row))throw new HttpError(409,'Sozlamalar boshqa sessiyada yangilangan. Serverdagi holatni qayta yuklang.','SETTINGS_CONFLICT');
}
const invalid=key=>{throw new HttpError(400,'Sozlama qiymati noto‘g‘ri: '+key,'INVALID_WORKSPACE_SETTING',key)};
const bool=v=>typeof v==='boolean';
const range=(min,max,integer=false)=>v=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max&&(!integer||Number.isInteger(v));
const oneOf=(...values)=>v=>values.includes(v);
const str=max=>v=>typeof v==='string'&&v.length<=max;
const time=v=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const fields={
 organization:{businessName:str(250),phone:str(100),address:str(1000),currency:oneOf('UZS','USD','EUR'),dateFormat:oneOf('DD.MM.YYYY','MM/DD/YYYY','YYYY-MM-DD'),timeFormat:oneOf('24','12')},
 pos:{defaultPayment:oneOf('cash','card','transfer','split','credit'),discountLimit:range(0,100),barcodeAutoAdd:bool,enterAddsProduct:bool,autoPrintReceipt:bool,saleConfirmation:bool,blockNegativeStock:bool,cashierDiscountAllowed:bool,holdCartEnabled:bool,paymentMethods:v=>record(v)&&Object.values(v).every(bool)},
 inventory:{defaultLowStock:range(0,1e12),blockNegativeStock:bool,transferApproval:bool,countApproval:bool},
 businessDay:{startTime:time,closeTime:time,maxShiftHours:range(1,48),warnBeforeCloseMinutes:range(0,240)},
 receipt:{width:oneOf('58','80'),template:oneOf('classic','compact','large'),copies:range(1,3,true),showLogo:bool,logoData:validThermalLogo,showCashier:bool,showPhone:bool,showAddress:bool,showPaymentBreakdown:bool,footer:str(1000)},
 loyalty:{enabled:bool,spendPerPoint:range(1000,1000000,true)},
 notifications:{lowStock:bool,outOfStock:bool,shift:bool,approvals:bool,billing:bool,supplierDebt:bool}
};
function checkSections(value,previous,prefix){
 if(!record(value))invalid(prefix);
 for(const [section,rules] of Object.entries(fields)){
  const row=value[section];if(row===undefined)continue;
  if(!record(row))invalid(prefix+section);
  for(const [key,check] of Object.entries(rules)){
   if(row[key]===undefined)continue;
   // Do not block unrelated edits because an old deployment stored a legacy value.
   if(JSON.stringify(canonical(row[key]))===JSON.stringify(canonical(previous?.[section]?.[key])))continue;
   if(!check(row[key]))invalid(prefix+section+'.'+key);
  }
 }
}
export function validateWorkspaceValues(value,previous={}){
 checkSections(value,previous,'');
 if(value.storeOverrides!==undefined){
  if(!record(value.storeOverrides))invalid('storeOverrides');
  for(const [id,override] of Object.entries(value.storeOverrides))checkSections(override,previous.storeOverrides?.[id],'storeOverrides.'+id+'.');
 }
}
