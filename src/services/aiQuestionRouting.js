// First-turn, read-only tool narrowing for unambiguous POS metric questions.
// It never authorizes access: executeAgentTool continues to enforce tenant/role scope.
export function simpleReportTopic(question){
 const q=String(question||'').normalize('NFKC').toLocaleLowerCase('uz').replace(/[\u200b-\u200f\u202a-\u202e]/g,'').trim();
 if(!q||q.length>1000||!/qancha|nechta|soni|jami|miqdori/iu.test(q))return null;
 if(/nega|nimaga|sababi|nima uchun|qanday|tahlil|batafsil|solishtir|taqqosla|farqi|trend|o[‘’ʻʼ']sish|pasayish|avvalgi|kecha|hafta|oy|ertaga|prognoz|qaysi mahsulot|qaysi filial|qaysi kun/iu.test(q))return null;
 if(/kirim|qabul qil|yarat|o[‘’ʻʼ']zgartir|o[‘’ʻʼ']chir|to[‘’ʻʼ']la|tasdiqla|mahsulotdan|tovardan|qoldiq/iu.test(q))return null;
 if(/bugun|bugungi/iu.test(q)&&/savdo|sotuv|chek|qaytarish|yalpi|brutto/iu.test(q)&&!/xarajat|foyda|daromad|tushum|qarz|nasiya|miqdor|mahsulot|tovar/iu.test(q))return 'today_sales';
 if(/mijoz|debitor/iu.test(q)&&/qarz|nasiya/iu.test(q)&&!/ta[‘’ʻʼ']minotch|supplier/iu.test(q))return 'customer_debt';
 if(/ta[‘’ʻʼ']minotch|supplier/iu.test(q)&&/qarz|nasiya/iu.test(q)&&!/mijoz|debitor/iu.test(q))return 'supplier_debt';
 return null;
}
