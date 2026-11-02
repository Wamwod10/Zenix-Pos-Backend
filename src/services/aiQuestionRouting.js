// First-turn, read-only tool narrowing for unambiguous POS metric questions.
// It never authorizes access: executeAgentTool continues to enforce tenant/role scope.
// Normalize only for intent detection. Preserve the user's original text for the
// model and evidence validation; no names, numeric values, or permissions change.
const cyrillic=Object.freeze({'а':'a','б':'b','в':'v','г':'g','ғ':'g\u0027','д':'d','е':'e','ё':'yo','ж':'j','з':'z','и':'i','й':'y','к':'k','қ':'q','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ў':'o\u0027','ф':'f','х':'x','ҳ':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sh','ъ':'\u0027','ь':'','э':'e','ю':'yu','я':'ya','ы':'i'});
export function normalizeUzbekQuestion(question){
 return String(question||'').normalize('NFKC').toLocaleLowerCase('uz')
  .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,'')
  .replace(/[‘’ʻʼ\u0060]/g,"'")
  .replace(/[а-яёғқўҳ]/gu,char=>cyrillic[char]??char)
  .replace(/\s+/g,' ').trim();
}

export function simpleReportTopic(question,{memory=null,businessDate=null}={}){
 const q=normalizeUzbekQuestion(question);
 if(!q||q.length>1000)return null;
 // Elliptical follow-ups are resolved only from verified today-sales report
 // identity for this exact business date, never a stale amount or guessed topic.
 const period=memory?.period;
 const isCurrent=businessDate&&period?.topic==='today_sales'&&period.from===businessDate&&period.to===businessDate;
 const elliptical=/^(?:(?:yalpi(?:si)?|brutto|sof savdo(?:si)?|qaytarish(?:lar)?(?:i)?|nechta chek|nechta savdo)\s*[- ]?chi|(?:yalpi(?:si)?|qaytarish(?:lar)?|nechta chek)\s*\?)\s*\??$/iu.test(q);
 if(isCurrent&&elliptical)return 'today_sales';
 if(!/qancha|nechta|soni|jami|miqdori/iu.test(q))return null;
 if(/nega|nimaga|sababi|nima uchun|qanday|tahlil|batafsil|solishtir|taqqosla|farqi|trend|o[‘’ʻʼ']sish|pasayish|avvalgi|kecha|hafta|oy|ertaga|prognoz|qaysi mahsulot|qaysi filial|qaysi kun/iu.test(q))return null;
 if(/kirim|qabul qil|yarat|o[‘’ʻʼ']zgartir|o[‘’ʻʼ']chir|to[‘’ʻʼ']la|tasdiqla|mahsulotdan|tovardan|qoldiq/iu.test(q))return null;
 if(/bugun|bugungi/iu.test(q)&&/savdo|sotuv|chek|qaytarish|yalpi|brutto/iu.test(q)&&!/xarajat|foyda|daromad|tushum|qarz|nasiya|miqdor|mahsulot|tovar/iu.test(q))return 'today_sales';
 if(/mijoz|debitor/iu.test(q)&&/qarz|nasiya/iu.test(q)&&!/ta[‘’ʻʼ']minotch|supplier/iu.test(q))return 'customer_debt';
 if(/ta[‘’ʻʼ']minotch|supplier/iu.test(q)&&/qarz|nasiya/iu.test(q)&&!/mijoz|debitor/iu.test(q))return 'supplier_debt';
 return null;
}

/**
 * A narrow read-only route for questions about the single most recent sale.
 * Do not interpret "last 7 days", comparisons or inventory actions as
 * requests for the latest receipt. Dates and product identifiers are not
 * inferred from conversational text.
 */
export function simpleLatestSaleQuestion(question){
 const q=normalizeUzbekQuestion(question);
 if(!q||q.length>1000)return false;
 if(!/(?:oxirgi|so'nggi|songgi)/iu.test(q)||
    !/(?:savdo|chek|sotil|sotg|sotuv|marta)/iu.test(q))return false;
 if(/(?:kecha|hafta|oy|kun(?:da|lar)|davr|oldingi|avvalgi|solishtir|taqqosla|batafsil|tahlil|nega|nimaga|sabab|kirim|qabul qil|yarat|o'chir|tasdiqla|qaytarish|qaytarilgan|ombor|qoldiq|foyda|xarajat)/iu.test(q))return false;
 return true;
}
