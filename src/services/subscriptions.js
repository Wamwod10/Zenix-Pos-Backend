import {HttpError} from '../lib/http.js';
import {databaseDateISO,organizationCalendarDateISO} from '../lib/businessDate.js';
import {addMonths,daysBetween} from '../config/billing.js';
import {BILLING_TIMEZONE,SUBSCRIPTION_PRICING_VERSION,subscriptionPlan,moneyUnits,moneyDecimal,unusedTermValue,roundRatio} from '../config/subscriptions.js';
import {assertNoConflictingBillingReview} from './pendingBillingReview.js';
import {writeAudit} from './audit.js';

export const billingDay=(now=new Date())=>organizationCalendarDateISO({timezone:BILLING_TIMEZONE},now);
export function isBusinessMutation(method,url){
  if(['GET','HEAD','OPTIONS'].includes(method))return false;
  const path=String(url||'').split('?')[0].replace(/\/$/,'');
  if(path.startsWith('/api/billing/')||path==='/api/billing'||path.startsWith('/api/platform/'))return false;
  if(path==='/api/auth/logout'||path==='/api/users/me/password'||path==='/api/settings/preferences')return false;
  if(method==='DELETE'&&/^\/api\/users\/me\/sessions\/(?:others|[0-9a-f-]+)$/.test(path))return false;
  return true;
}
export async function subscriptionState(db,organizationId){
  const org=(await db.query(`SELECT o.*,subscription_effective_plan(o.id) AS effective_plan_code,
    subscription_can_write(o.id) AS subscription_writable,
    (SELECT billing_interval FROM subscription_terms WHERE organization_id=o.id AND superseded_at IS NULL
      AND starts_on <= (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date AND ends_on > (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date ORDER BY starts_on DESC,id LIMIT 1) AS effective_interval
    FROM organizations o WHERE o.id=$1`,[organizationId])).rows[0];
  if(!org)throw new HttpError(404,'Biznes topilmadi','ORG_NOT_FOUND');
  const plan=subscriptionPlan(org.effective_plan_code||org.plan_code||'BUSINESS',org.pricing_version||1);
  return {planCode:plan.code,legacy:!org.plan_code,pricingVersion:org.pricing_version||1,version:Number(org.subscription_version||0),
    accessMode:org.license_status==='SUSPENDED'?'SUSPENDED':org.subscription_writable?'READ_WRITE':'READ_ONLY',
    trialStartedAt:org.settings?.trialStartedAt||null,trialEndsAt:org.settings?.trialEndsAt||null,
    expiryDate:org.expiry_date,billingInterval:org.settings?.trialEndsAt||!org.expiry_date?null:org.effective_interval||org.plan,limits:plan.limits,creditBalance:Number(org.subscription_credit||0),
    scheduledDowngrade:org.subscription_pending_plan?{planCode:org.subscription_pending_plan,effectiveOn:org.subscription_change_on}:null};
}
export async function changeTrialPlan(db,{organizationId,userId,planCode}){
  const plan=subscriptionPlan(planCode);
  const org=(await db.query('SELECT * FROM organizations WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
  if(!org)throw new HttpError(404,'Biznes topilmadi','ORG_NOT_FOUND');
  if(org.license_status==='SUSPENDED')throw new HttpError(403,'Biznes bloklangan','ACCOUNT_SUSPENDED');
  if(!org.settings?.trialEndsAt||!(Date.parse(org.settings.trialEndsAt)>Date.now()))throw new HttpError(409,'Faol trial topilmadi','TRIAL_NOT_ACTIVE');
  await assertNoConflictingBillingReview(db,organizationId);
  if(org.plan_code===planCode)return {planCode,trialEndsAt:org.settings.trialEndsAt};
  await db.query('UPDATE organizations SET plan_code=$2,pricing_version=$3,store_limit=$4,subscription_version=subscription_version+1,updated_at=now() WHERE id=$1',[organizationId,planCode,SUBSCRIPTION_PRICING_VERSION,plan.limits.stores]);
  await writeAudit(db,{organizationId,userId,action:'trial_plan_changed',entityType:'organization',entityId:organizationId,title:'Trial tarifi o‘zgartirildi',before:{planCode:org.plan_code},after:{planCode,trialEndsAt:org.settings.trialEndsAt}});
  return {planCode,trialEndsAt:org.settings.trialEndsAt};
}
export async function scheduleDowngrade(db,{organizationId,userId,planCode,cancel=false}){
  const org=(await db.query('SELECT o.*,subscription_effective_plan(o.id) AS effective_plan_code FROM organizations o WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
  if(!org)throw new HttpError(404,'Biznes topilmadi','ORG_NOT_FOUND');
  if(org.license_status==='SUSPENDED')throw new HttpError(403,'Biznes bloklangan','ACCOUNT_SUSPENDED');
  await assertNoConflictingBillingReview(db,organizationId);
  if(cancel&&org.subscription_change_on&&databaseDateISO(org.subscription_change_on)<=billingDay())throw new HttpError(409,'Downgrade allaqachon kuchga kirgan','CHANGE_ALREADY_EFFECTIVE');
  if(org.subscription_pending_plan){
    const funded=(await db.query('SELECT id FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NULL AND starts_on>$2::date AND plan_code=$3 LIMIT 1',[organizationId,billingDay(),org.subscription_pending_plan])).rows[0];
    if(funded)throw new HttpError(409,'Kelajak tarifi uchun to‘lov tasdiqlangan. Avval to‘langan davrni kelishtiring','FUNDED_DOWNGRADE_CONFLICT');
  }
  if(!cancel){
    const target=subscriptionPlan(planCode),current=subscriptionPlan(org.effective_plan_code);
    if(target.rank>=current.rank)throw new HttpError(400,'Pastroq tarif tanlang','NOT_A_DOWNGRADE');
    if(org.settings?.trialEndsAt)throw new HttpError(409,'Trial tarifini trial-plan orqali almashtiring','TRIAL_PLAN_CHANGE_REQUIRED');
    if(!org.expiry_date||databaseDateISO(org.expiry_date)<billingDay())throw new HttpError(409,'Faol pullik obuna topilmadi','PAID_SUBSCRIPTION_REQUIRED');
  }
  const effectiveOn=cancel?null:nextDay(databaseDateISO(org.expiry_date));
  await db.query('UPDATE organizations SET subscription_pending_plan=$2,subscription_change_on=$3,subscription_version=subscription_version+1,updated_at=now() WHERE id=$1',[organizationId,cancel?null:planCode,effectiveOn]);
  await writeAudit(db,{organizationId,userId,action:cancel?'downgrade_cancelled':'downgrade_scheduled',entityType:'organization',entityId:organizationId,title:'Obuna o‘zgarishi',after:{planCode:cancel?null:planCode,effectiveOn}});
  return {planCode:cancel?null:planCode,effectiveOn};
}
export const nextDay=date=>{
  const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+1);return value.toISOString().slice(0,10);
};
export const previousDay=date=>{
  const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()-1);return value.toISOString().slice(0,10);
};

// Called with the organization already locked. No prices/status are read from client metadata.
export async function quoteSubscription(db,org,input){
  const today=billingDay();
  const effective=(await db.query(`SELECT subscription_effective_plan($1) AS code,
    (SELECT billing_interval FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NULL
      AND starts_on<=$2::date AND ends_on>$2::date ORDER BY starts_on DESC,id LIMIT 1) AS interval`,[org.id,today])).rows[0];
  const currentCode=effective.code,currentInterval=effective.interval||org.plan;
  const planCode=input.planCode||currentCode;
  const target=subscriptionPlan(planCode),current=subscriptionPlan(currentCode);
  const interval=input.billingInterval||input.plan;
  if(!['MONTHLY','ANNUAL'].includes(interval))throw new HttpError(400,'To‘lov davri noto‘g‘ri','INVALID_BILLING_INTERVAL');
  const trial=Boolean(org.settings?.trialEndsAt);
  const paidActive=!trial&&Boolean(org.expiry_date&&databaseDateISO(org.expiry_date)>=today);
  let action=paidActive?(target.rank>current.rank?'UPGRADE':'RENEW'):'ACTIVATE';
  if(paidActive&&target.rank<current.rank){
    if(org.subscription_pending_plan!==planCode)throw new HttpError(409,'Avval downgrade rejalashtiring','DOWNGRADE_REQUIRED');
    action='RENEW';
  }
  if(paidActive&&target.rank===current.rank&&interval!==currentInterval&&input.intent==='CHANGE_PLAN')action='UPGRADE';
  if(action==='RENEW'&&org.subscription_pending_plan&&planCode!==org.subscription_pending_plan)throw new HttpError(409,'Rejalangan tarif uchun renewal qiling yoki downgrade’ni bekor qiling','SCHEDULED_PLAN_CONFLICT');
  let startsOn=action==='RENEW'?nextDay(databaseDateISO(org.expiry_date)):today;
  let endsOn=addMonths(startsOn,interval==='MONTHLY'?1:12);
  if(action==='RENEW'&&input.selectedEndDate){
    // Legacy renewal endpoint accepts an inclusive expiry date.
    endsOn=nextDay(input.selectedEndDate);
    if(endsOn<=startsOn)throw new HttpError(400,'Uzaytirish sanasi noto‘g‘ri','INVALID_RENEWAL_DATE');
  }
  let gross=moneyUnits(target.prices[interval]);
  if(action==='RENEW'&&input.selectedEndDate)gross=roundRatio(gross,daysBetween(startsOn,endsOn),daysBetween(startsOn,addMonths(startsOn,interval==='MONTHLY'?1:12)));
  let availableCredit=moneyUnits(org.subscription_credit||'0');
  if(action==='UPGRADE'){
    const terms=(await db.query('SELECT * FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NULL AND ends_on>$2::date ORDER BY starts_on,id FOR UPDATE',[org.id,today])).rows;
    if(!terms.length)throw new HttpError(409,'Eski obuna qiymatini administrator tekshirishi kerak','LEGACY_SUBSCRIPTION_REVIEW_REQUIRED');
    for(const term of terms)availableCredit+=unusedTermValue(term,today);
  }
  const credit=availableCredit<gross?availableCredit:gross;
  return {planCode,billingInterval:interval,action,pricingVersion:SUBSCRIPTION_PRICING_VERSION,subscriptionVersion:Number(org.subscription_version||0),
    startsOn,endsOn,pricingDay:today,grossAmount:moneyDecimal(gross),creditAmount:moneyDecimal(credit),remainingCredit:moneyDecimal(availableCredit-credit),
    baseAmount:Number(moneyDecimal(gross-credit)),currentPlanCode:currentCode,
    legacyStoreBonus:org.plan_code?Number(org.legacy_store_bonus||0):Math.max(0,Number(org.store_limit||2)-2)};
}

export async function approveSubscription(db,org,payment,draft){
  let quote=draft.metadata?.subscription;
  if(!quote)return false;
  if(Number(org.subscription_version||0)!==quote.subscriptionVersion)throw new HttpError(409,'Obuna o‘zgargan. Hisobni qayta tekshiring','SUBSCRIPTION_QUOTE_STALE');
  if(quote.action==='UPGRADE'&&quote.pricingDay!==billingDay())throw new HttpError(409,'Upgrade hisobi boshqa kunda tasdiqlanmaydi','SUBSCRIPTION_QUOTE_STALE');
  if(quote.endsOn<=billingDay())throw new HttpError(409,'Xizmat davri tugagan','SUBSCRIPTION_QUOTE_STALE');
  const plan=subscriptionPlan(quote.planCode,quote.pricingVersion);
  if(payment.plan!==quote.billingInterval||databaseDateISO(payment.service_period_from)!==quote.startsOn||databaseDateISO(payment.service_period_to)!==previousDay(quote.endsOn)||moneyUnits(payment.amount)!==moneyUnits(draft.total_amount))throw new HttpError(409,'To‘lov hisobga mos emas','SUBSCRIPTION_QUOTE_STALE');
  if(quote.action==='ACTIVATE'&&quote.startsOn!==billingDay()){
    const duration=daysBetween(quote.startsOn,quote.endsOn);
    const full=addMonths(quote.startsOn,quote.billingInterval==='MONTHLY'?1:12)===quote.endsOn;
    const start=billingDay();
    if(!full||duration<=0)throw new HttpError(409,'Aktivatsiya hisobi noto‘g‘ri','SUBSCRIPTION_QUOTE_STALE');
    quote={...quote,startsOn:start,endsOn:addMonths(start,quote.billingInterval==='MONTHLY'?1:12)};
    await db.query('UPDATE billing_payments SET service_period_from=$2,service_period_to=$3,extension_days=$4 WHERE id=$1',[payment.id,quote.startsOn,previousDay(quote.endsOn),daysBetween(quote.startsOn,quote.endsOn)]);
  }
  if(quote.action==='UPGRADE')await db.query('UPDATE subscription_terms SET superseded_at=now() WHERE organization_id=$1 AND superseded_at IS NULL AND ends_on>$2::date',[org.id,quote.pricingDay]);
  const value=moneyDecimal(moneyUnits(payment.amount)+moneyUnits(quote.creditAmount));
  await db.query(`INSERT INTO subscription_terms(organization_id,payment_id,plan_code,pricing_version,billing_interval,starts_on,ends_on,value_amount)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[org.id,payment.id,quote.planCode,quote.pricingVersion,quote.billingInterval,quote.startsOn,quote.endsOn,value]);
  // A future renewal must not change the current tariff, interval or store capacity.
  const immediate=quote.startsOn<=billingDay();
  await db.query(`UPDATE organizations SET plan_code=CASE WHEN $2 THEN $3 ELSE COALESCE(plan_code,'BUSINESS') END,
    pricing_version=$4,plan=CASE WHEN $2 THEN $5 ELSE plan END,expiry_date=$6,
    store_limit=CASE WHEN $2 THEN $7 ELSE store_limit END,subscription_credit=$8,
    legacy_expiry_date=CASE WHEN $2 THEN NULL ELSE legacy_expiry_date END,
    subscription_pending_plan=CASE WHEN $2 THEN NULL ELSE subscription_pending_plan END,
    subscription_change_on=CASE WHEN $2 THEN NULL ELSE subscription_change_on END,
    legacy_store_bonus=$9,
    license_status=CASE WHEN license_status='SUSPENDED' THEN 'SUSPENDED' ELSE 'ACTIVE' END,
    settings=jsonb_set(COALESCE(settings,'{}'::jsonb)-'trialEndsAt','{billingHold}',CASE WHEN license_status='SUSPENDED' THEN COALESCE(settings->'billingHold','false'::jsonb) ELSE 'false'::jsonb END,true),
    subscription_version=subscription_version+1,updated_at=now() WHERE id=$1`,
    [org.id,immediate,quote.planCode,quote.pricingVersion,quote.billingInterval,previousDay(quote.endsOn),plan.limits.stores+quote.legacyStoreBonus,quote.remainingCredit,quote.legacyStoreBonus]);
  await db.query(`INSERT INTO subscription_events(organization_id,payment_id,event_type,payload) VALUES($1,$2,$3,$4)`,[org.id,payment.id,quote.action,{...quote,amount:payment.amount,valueAmount:value}]);
  return {startsOn:quote.startsOn,endsOn:quote.endsOn};
}
