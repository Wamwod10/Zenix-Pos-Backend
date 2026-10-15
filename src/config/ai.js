// OpenAI GPT-6 Luna standard text pricing as of 2026-10-13.
// Costs are USD micro-dollars per 1M tokens. Cached input is billed at
// the uncached rate here to avoid underestimating cost.
export const AI_MODEL='gpt-6-luna';
export const AI_PRICING_VERSION=2;
export const AI_RATES=Object.freeze({inputMicrosPerMillion:100000,outputMicrosPerMillion:500000});
export function tokenCostMicros(input,output){
  if(![input,output].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('Invalid AI token counts');
  return Number((BigInt(input)*BigInt(AI_RATES.inputMicrosPerMillion)+BigInt(output)*BigInt(AI_RATES.outputMicrosPerMillion)+999999n)/1000000n);
}
export function aiSettings(source=process.env){
  const integer=(key,fallback,min,max)=>{const n=Number(source[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return n};
  const approved=source.ZENIX_AI_PROVIDER_APPROVED==='true'&&source.ZENIX_AI_DATA_PROCESSING_APPROVED==='true'&&source.ZENIX_AI_PAID_PROJECT_CONFIRMED==='true';
  const model=source.ZENIX_AI_MODEL??AI_MODEL;
  // Reject unpriced models instead of applying this model's rates to them.
  if(model!==AI_MODEL)throw new Error('Invalid ZENIX_AI_MODEL');
  return {enabled:source.ZENIX_AI_ENABLED==='true'&&approved&&(source.NODE_ENV!=='production'||source.ZENIX_AI_PRODUCTION_APPROVED==='true')&&Boolean(source.OPENAI_API_KEY),
    apiKey:source.OPENAI_API_KEY||'',model,pricingVersion:AI_PRICING_VERSION,writesEnabled:source.ZENIX_AI_WRITES_ENABLED==='true',
    maxInputTokens:integer('ZENIX_AI_MAX_INPUT_TOKENS',8000,256,8000),maxOutputTokens:integer('ZENIX_AI_MAX_OUTPUT_TOKENS',1200,128,1200),
    timeoutMs:integer('ZENIX_AI_TIMEOUT_MS',20000,1000,20000),maxRequestMicros:integer('ZENIX_AI_MAX_REQUEST_MICROS',2000,1,2000),
    businessMonthlyMicros:integer('ZENIX_AI_BUSINESS_MONTHLY_MICROS',500000,1,10000000),premiumMonthlyMicros:integer('ZENIX_AI_PREMIUM_MONTHLY_MICROS',2500000,1,10000000),
    dailyMicros:integer('ZENIX_AI_DAILY_MICROS',25000000,1,100000000),userPerMinute:integer('ZENIX_AI_USER_PER_MINUTE',3,1,10),businessPerMinute:integer('ZENIX_AI_BUSINESS_PER_MINUTE',10,1,30),maxConcurrent:integer('ZENIX_AI_MAX_CONCURRENT',2,1,5)};
}
// A misconfigured optional provider must not prevent POS startup.
export function aiRuntimeSettings(source=process.env){
  try{return aiSettings(source)}catch{return {...aiSettings({}),configurationError:'AI_CONFIG_INVALID'}}
}
