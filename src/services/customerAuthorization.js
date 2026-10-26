import {hasPermission} from '../lib/permissions.js';
import {HttpError} from '../lib/http.js';

// Contact fields retain the moduleSales policy. These fields affect future
// credit/price eligibility; changing them requires a separate permission.
export const CUSTOMER_FINANCIAL_FIELDS=Object.freeze({
 creditLimit:{column:'credit_limit',defaultValue:0},
 defaultCreditDays:{column:'default_credit_days',defaultValue:0},
 customerType:{column:'customer_type',defaultValue:'REGULAR'},
 loyaltyTier:{column:'loyalty_tier',defaultValue:'STANDARD'},
});

// Call with validated input and the organization-scoped, locked row on PATCH.
export function assertCustomerFinancialWrite(user,input,current=null){
 const changed=Object.entries(CUSTOMER_FINANCIAL_FIELDS).filter(([key,{column,defaultValue}])=>{
  if(!Object.prototype.hasOwnProperty.call(input,key)||input[key]===undefined)return false;
  const previous=current?(current[key]??current[column]??defaultValue):defaultValue;
  return typeof defaultValue==='number'?Number(input[key])!==Number(previous):input[key]!==previous;
 }).map(([key])=>key);
 if(changed.length&&!hasPermission(user,'customerFinancialWrite'))throw new HttpError(403,'Mijoz moliyaviy sozlamalarini tahrirlash uchun ruxsat yoq','CUSTOMER_FINANCIAL_WRITE_FORBIDDEN',{fields:changed});
}
