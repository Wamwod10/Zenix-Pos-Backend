import { databaseDateISO } from '../lib/businessDate.js';
import { HttpError } from '../lib/http.js';

// A billing draft is a price quote, not a perpetual authorization to charge a
// historical plan/branch count. Recalculate immediately before accepting a
// receipt because an administrator or another cashier may have changed the
// tenant's license since the quote was created.
const date = (value) => value == null ? null : databaseDateISO(value);
const money = (value) => Number(value ?? 0);

export function draftRecalculationInput(draft) {
  return {
    type: draft.type,
    plan: draft.plan,
    intent: draft.type === 'EXTRA' ? 'EXTRA' : draft.metadata?.intent || 'RENEW',
    selectedEndDate: date(draft.selected_end_date),
    extraStoreCount: Number(draft.extra_store_count ?? 0),
    metadata: {},
    ...(draft.metadata?.promoCode?{promoCode:draft.metadata.promoCode}:{}),
  };
}

export function assertBillingDraftCurrent(draft, calculated) {
  const same = draft.type === calculated.type &&
    draft.plan === calculated.plan &&
    date(draft.current_end_date) === calculated.currentEndDate &&
    date(draft.selected_end_date) === calculated.selectedEndDate &&
    money(draft.extension_days) === calculated.extensionDays &&
    money(draft.base_amount) === calculated.baseAmount &&
    money(draft.extra_store_count) === calculated.extraStoreCount &&
    money(draft.extra_store_amount) === calculated.extraStoreAmount &&
    money(draft.total_amount) === calculated.totalAmount &&
    // Legacy drafts may not have this hint; validate every new quote that does.
    (draft.metadata?.activeStores == null ||
      money(draft.metadata.activeStores) === calculated.activeStores);
  if (!same) {
    throw new HttpError(409,
      'Tarif, filiallar soni yoki obuna muddati o‘zgargan. Yangi to‘lov hisobini yarating.',
      'BILLING_DRAFT_STALE');
  }
}
