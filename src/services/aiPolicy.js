import {z} from 'zod';
import {hasPermission} from '../lib/permissions.js';
import {isBranchLocked} from '../lib/storeScope.js';
import {HttpError} from '../lib/http.js';
import {sha256} from '../lib/crypto.js';
export const AI_SUGGESTIONS=Object.freeze({today_sales:'Bugun qancha savdo bo‘ldi?',top_products:'Oxirgi haftada eng ko‘p sotilgan mahsulotlar qaysilar?',low_stock:'Qaysi mahsulotlar omborda kamayib boryapti?',dormant:'Qaysi tovarlar uzoq vaqt sotilmayapti?',profit:'Qaysi mahsulotlar ko‘proq foyda keltirdi?',expenses:'Xarajatlar holati qanday?',customer_debt:'Mijozlar qarzdorligi qancha?',supplier_debt:'Ta’minotchilar qarzdorligi qancha?',branches:'Filiallar savdosi o‘rtasidagi farq qanday?',recommendations:'Biznes faoliyatini yaxshilash uchun nimalar tavsiya qilinadi?'});
export const AI_INSIGHTS=Object.freeze({CHECK_WEEKLY:'Savdo tendensiyasini bir xil davrlar bo‘yicha muntazam solishtiring.',REPLENISH:'Minimal qoldiqdan past mahsulotlar uchun kirim va yetkazib berish rejasini tekshiring.',REVIEW_DORMANT:'Oxirgi 30 biznes kunida sotilmagan qoldiq uchun talab va assortimentni tekshiring.',FIX_COST_DATA:'Foydani tahlil qilishdan oldin yetishmayotgan tarixiy tannarx ma’lumotlarini tekshiring.',REVIEW_EXPENSES:'Xarajat toifalarini tekshirib, takrorlanuvchi xarajatlarni kuzating.',REVIEW_CUSTOMER_DEBT:'Mijozlar qarzdorligini alohida tekshiring; qaytarish va to‘lov hujjatlarini solishtiring.',REVIEW_SUPPLIER_DEBT:'Ta’minotchi qarzlari va to‘lov hujjatlarini kelishtiring.',COMPARE_BRANCHES:'Filiallarni davr, ish vaqti va assortiment farqlarini hisobga olib solishtiring.'});
export function allowedTopics(user){
  if(!user||user.appRole==='PLATFORM_ADMIN')return [];
  const can=p=>hasPermission(user,p),topics=[];
  if(['moduleDashboard','moduleHistory','moduleAnalytics','moduleSellerAnalytics'].some(can))topics.push('today_sales','top_products');
  if(can('moduleInventory')&&can('moduleProducts'))topics.push('low_stock','dormant');
  if(can('moduleAnalytics')&&can('analytics')){topics.push('profit');if(!isBranchLocked(user))topics.push('branches');if(!isBranchLocked(user)&&can('moduleSales'))topics.push('customer_debt')}
  if(can('moduleExpenses'))topics.push('expenses');if(can('moduleSuppliers'))topics.push('supplier_debt');
  if(topics.length)topics.push('recommendations');return topics;
}
export function questionTopic(question){
  const text=String(question||'').normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g,'').toLowerCase();
  if(/ignore|previous instructions|system prompt|api[_\s-]?key|parol|password|secret|boshqa (biznes|tenant|tashkilot)|select\s+.+\s+from|\b(drop|delete|insert|update|sql)\b/.test(text))throw new HttpError(400,'Bu so‘rov xavfsiz biznes tahliliga tegishli emas','AI_UNSAFE_QUESTION');
  if(/tavsiya|yaxshila|recommend/.test(text))return 'recommendations';
  if(/filial.*(farq|solishtir)|branch.*compar/.test(text))return 'branches';
  if(/foyda|profit/.test(text))return 'profit';
  if(/xarajat|expense/.test(text))return 'expenses';
  if(/qarz|debt/.test(text))return /ta.minot|supplier/.test(text)?'supplier_debt':'customer_debt';
  if(/uzoq|sotilmay|dormant|slow.?mov/.test(text))return 'dormant';
  if(/kamay|qoldiq|low.?stock/.test(text))return 'low_stock';
  if(/eng ko.p|most.?sold|top product/.test(text))return 'top_products';
  if(/bugun|today/.test(text)&&/savdo|sot|sale/.test(text))return 'today_sales';
  throw new HttpError(400,'Tavsiya etilgan biznes savollaridan birini tanlang','AI_QUESTION_UNSUPPORTED');
}
export function authorizeTopic(user,topic){if(!allowedTopics(user).includes(topic))throw new HttpError(403,'Bu tahlil ma’lumotlariga ruxsat yo‘q','AI_FORBIDDEN')}
export const authorizationKey=user=>sha256(JSON.stringify([user.organizationId,user.appRole,user.storeId||null,user.permissionOverrides||{},user.rolePermissions||{}]));
export function providerFacts(report){return report.facts.filter(f=>f.value!==null).map(({id,value,unit})=>({id,value,unit}))}
export function validateSelection(output,report){
  const schema=z.object({factIds:z.array(z.string()).max(6),insightIds:z.array(z.string()).max(3)}).strict();
  const parsed=schema.safeParse(output);
  if(!parsed.success||new Set(parsed.data.factIds).size!==parsed.data.factIds.length||new Set(parsed.data.insightIds).size!==parsed.data.insightIds.length||parsed.data.factIds.some(id=>!report.facts.some(f=>f.id===id&&f.value!==null))||parsed.data.insightIds.some(id=>!report.eligibleInsights.includes(id)))throw new HttpError(502,'AI javobi tasdiqlangan ma’lumotlarga mos emas','AI_INVALID_RESPONSE');
  return parsed.data;
}
