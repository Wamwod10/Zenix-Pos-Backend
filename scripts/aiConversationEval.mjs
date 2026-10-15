import {pathToFileURL} from 'node:url';
import {aiSettings} from '../src/config/ai.js';
import {createAiAgentProvider} from '../src/services/aiAgentProvider.js';
import {buildAgentEvidence,renderAgentAnswer} from '../src/services/aiAgentReply.js';

// Synthetic fixtures only. This module deliberately never imports app/DB/registry.
const groups=[
 ['welcome','greeting',['Salom, qanday yordam bera olasiz?','Sizdan biznes haqida nimalarni so\'rasam bo\'ladi?','Savdo hisobotini qanday tushunaman?','Xarajat va foyda orasidagi farq nima?','Biznesni tekshirish uchun 3 maslahat bering.']],
 ['inventory','inventory',['Omborda jami nechta mahsulot bor?','Minimumdan past mahsulot nechta?','Jami 2 ta bo\'lsa, nega minimumda 0 ta?','Qoldig\'i bor mahsulot bilan katalogdagi mahsulot bir xilmi?','Buni oddiyroq tushuntiring.']],
 ['sales','sales',['Bugungi savdo qancha?','Bu yalpi savdomi yoki qaytarishdan keyingimi?','Qaytarishlar ham hisobga olinganmi?','Savdo nega shunday bo\'lgan?','Ertaga qancha sotamiz deb o\'ylaysiz?']],
 ['comparison','comparison',['2026-10-01 dan 2026-10-07 gacha savdoni oldingi hafta bilan solishtiring.','Qaysi davr ko\'proq savdo qilgan?','Farq qancha?','Bu o\'sishning sababini ayta olasizmi?','Shu raqamlar asosida qanday umumiy tavsiya berasiz?']],
 ['products','products',['Guruch mahsulotini toping.','Uning ombordagi qoldig\'i qancha?','Eng yaxshi sotilgan mahsulot qaysi?','Kam sotilgan mahsulotning sababi nima?','Yana qaysi ma\'lumotni tekshirish kerak?']],
 ['receipt','receipt_clarification',['Guruchdan 10 kilo kirim qilmoqchiman.','Kirim uchun yana nima kerak?','Tannarxni hozir bilmayman, nima qilaman?','Tasdiqlamasdan kirim bajariladimi?','Hozircha faqat nimani tayyorlash mumkin?']],
 ['latest','latest_sale',['Ohirgi savdo haqida malumot ber.','Охирги савдода нималар сотилган?','Bugun savdo bo‘lmasa ham oxirgi chekni toping.','O‘sha savdoning to‘lov usuli qanday?','Boshqa filialdagi oxirgi savdoni ko‘rish uchun doirani almashtirish kerakmi?']],
 ['ranking','quantity_vs_revenue',['Eng kop qaysi tovar sotilgan?','Miqdor bo‘yicha ayting, tushum bo‘yicha emas.','Quruq salfetka 100 dona nomidagi 100 sotilgan miqdormi?','Eng ko‘p tushum bergan mahsulot qaysi?','Eng yaxshi mahsulot deganda miqdor, tushum yoki foydani nazarda tutishimni aniqlashtiring.']],
];
export const AI_CONVERSATION_EVAL_CASES=Object.freeze(groups.flatMap(([conversation,capability,questions])=>questions.map((question,index)=>Object.freeze({id:conversation+'_'+(index+1),conversation,question,expectedCapabilities:[capability,...(index?['context_followup']:[])]}))));
const topics=['inventory','sales','comparison','products','receipt','latest','ranking'];
const tools=[{type:'function',name:'read_synthetic_fixture',description:'Read synthetic test data only. inventory: total vs low stock; sales/comparison: dated reports; products: product stock; receipt: missing receipt fields, no execution.',strict:true,parameters:{type:'object',properties:{topic:{type:'string',enum:topics}},required:['topic'],additionalProperties:false}}];
const report=(facts,notes=[],dates={})=>({kind:'report',report:{topic:'synthetic',from:'2026-10-15',to:'2026-10-15',storeId:null,facts,tables:[],notes,...dates}});
const fact=(id,label,value,unit='count')=>({id,label,value,unit});
const fixtures={
 latest:report([fact('number','Oxirgi savdo raqami','TEST-014','text'),fact('date','Oxirgi savdo vaqti','2026-10-14T10:00:00+05:00','text'),fact('total','Oxirgi savdo jami','69000','UZS'),fact('payment','To‘lov usuli','Naqd','text'),fact('item','Quruq salfetka 100 dona sotilgan miqdori','2','dona')],['Bugun savdo yo‘q. Bu barcha sanalar orasidagi oxirgi savdo; mahsulot nomidagi 100 qadoq tavsifi, sotilgan miqdor emas.'],{from:'2026-10-14',to:'2026-10-14'}),
 ranking:report([fact('quantity_leader','Miqdor bo‘yicha yetakchi: Quruq salfetka 100 dona','2','dona'),fact('quantity_revenue','Quruq salfetka 100 dona sof tushumi','69000','UZS'),fact('revenue_leader','Tushum bo‘yicha yetakchi: Choy','90000','UZS'),fact('revenue_quantity','Choy sotilgan miqdori','1','dona')],['Reyting miqdor va tushum uchun alohida. Mahsulot nomidagi 100 dona qadoq tavsifi, sotilgan miqdor 2 dona. Foyda haqida tannarxsiz xulosa berilmaydi.']),
 inventory:report([fact('total','Jami faol katalog mahsulotlari',2),fact('stocked','Qoldiq bor mahsulotlar',2),fact('low','Minimumdan past mahsulotlar',0)],['Jami katalog va minimumdan past mahsulotlar alohida ko\'rsatkichlar. Minimumdan past son jami katalog soni emas.']),
 sales:report([fact('gross','Yalpi savdo',120000,'UZS'),fact('refunds','Qaytarish',20000,'UZS'),fact('net','Sof savdo',100000,'UZS')],['Sabab va prognoz uchun tarixiy dalil yetarli emas.']),
 comparison:report([{...fact('current','Joriy davr sof savdosi',100000,'UZS'),from:'2026-10-01',to:'2026-10-07'},{...fact('prior','Taqqoslash davri sof savdosi',80000,'UZS'),from:'2026-09-24',to:'2026-09-30'},fact('difference','Joriy davr minus oldingi davr',20000,'UZS')],['Davrlar farqi sababni isbotlamaydi.'],{from:'2026-10-01',to:'2026-10-07',comparisonFrom:'2026-09-24',comparisonTo:'2026-09-30'}),
 products:{kind:'stock',productName:'Guruch (synthetic)',unit:'kg',locations:[{storeName:'Test filial',warehouseName:'Test ombor',quantity:'7.000'}]},
 receipt:{kind:'clarification',message:'Kirim kartasi uchun ombor va tannarxni aniqlashtiring. Hech qanday kirim bajarilmadi.'},
};
const safeCodes=new Set(['AI_INVALID_RESPONSE','AI_EVIDENCE_INVALID','AI_PROVIDER_FAILURE','AI_TIMEOUT','AI_TOKEN_LIMIT','AI_COST_LIMIT','AI_UNAVAILABLE']);
export async function runAiConversationEval({source=process.env,fetchImpl=fetch,write=console.log,cases=AI_CONVERSATION_EVAL_CASES}={}){
 if(source.ZENIX_AI_LIVE_EVAL!=='true')throw new Error('Synthetic eval requires explicit opt-in');
 if(!source.OPENAI_API_KEY?.trim())throw new Error('Synthetic eval requires server API key');
 if(!Array.isArray(cases)||cases.length>40)throw new Error('Synthetic eval case limit');
 const settings={...aiSettings({OPENAI_API_KEY:source.OPENAI_API_KEY,ZENIX_AI_MODEL:source.ZENIX_AI_MODEL}),enabled:true,writesEnabled:false};
 const provider=createAiAgentProvider(settings,fetchImpl),maxTotalCostMicros=60000;
 const totals={inputTokens:0,outputTokens:0,costMicros:0,requests:0};
 let conversation=null,previous=[],priorResults=[];
 const results=[];
 for(const entry of cases){
  if(entry.conversation!==conversation){conversation=entry.conversation;previous=[];priorResults=[];}
  const history=[{role:'developer',content:'Isolated synthetic evaluation, date 2026-10-15. All fixtures are fictional. Use tools for business facts; distinguish general advice, never execute actions. Missing evidence requires clarification. Earlier verified facts can explain followups; fresh factual questions need tools.'},...previous,{role:'user',content:entry.question}];
  const used=[],currentResults=[];const usage={inputTokens:0,outputTokens:0,costMicros:0,requests:0};
  let answer=null,status='call_limit',errorCode=null;
  const account=value=>{
   if(!value||![value.inputTokens,value.outputTokens,value.cost].every(n=>Number.isSafeInteger(n)&&n>=0))return;
   usage.inputTokens+=value.inputTokens;usage.outputTokens+=value.outputTokens;usage.costMicros+=value.cost;
   totals.inputTokens+=value.inputTokens;totals.outputTokens+=value.outputTokens;totals.costMicros+=value.cost;
  };
  try{
   for(let step=0;step<3;step++){
    const budget={inputTokens:settings.maxInputTokens-usage.inputTokens,outputTokens:settings.maxOutputTokens-usage.outputTokens,cost:Math.min(settings.maxRequestMicros-usage.costMicros,maxTotalCostMicros-totals.costMicros)};
    const evidence=buildAgentEvidence([...currentResults,...priorResults]);
    const result=await provider(history,{tools,evidence,budget,signal:AbortSignal.timeout(settings.timeoutMs),onDispatch:async()=>{usage.requests++;totals.requests++;}});
    account(result);
    if(result.reply){answer=renderAgentAnswer(result.reply,currentResults,{evidence});status='answered';break;}
    history.push(...result.items);
    for(const call of result.calls){
     if(call.name!=='read_synthetic_fixture'||Object.keys(call.args).length!==1||!topics.includes(call.args.topic))throw Object.assign(new Error(),{code:'AI_INVALID_RESPONSE'});
     const result=fixtures[call.args.topic];used.push(call.args.topic);currentResults.push({name:call.name,result});
     history.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(result)});
    }
   }
  }catch(error){account(error.aiUsage);status='error';errorCode=safeCodes.has(error.code)?error.code:'EVAL_FAILED';}
  const item={id:entry.id,question:entry.question,expectedCapabilities:entry.expectedCapabilities,status,answer,errorCode,verifiedEvidence:buildAgentEvidence([...currentResults,...priorResults]),metrics:{...usage,syntheticToolTopics:used,evidenceCount:buildAgentEvidence([...currentResults,...priorResults]).length},needsHumanReview:true};
  results.push(item);write(JSON.stringify(item));
  if(answer){previous=[{role:'user',content:entry.question},{role:'assistant',content:JSON.stringify({answer,verifiedResults:currentResults})}];if(Buffer.byteLength(JSON.stringify(previous))>2500)previous=[];}
  priorResults=[...currentResults,...priorResults].slice(0,3);
  if(totals.costMicros>=maxTotalCostMicros)break;
 }
 const summary={synthetic:true,needsHumanReview:true,caseCount:results.length,answered:results.filter(r=>r.status==='answered').length,totals,maxTotalCostMicros};
 write(JSON.stringify(summary));return {results,summary};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runAiConversationEval().catch(()=>{console.error('AI synthetic evaluation failed');process.exitCode=1});
