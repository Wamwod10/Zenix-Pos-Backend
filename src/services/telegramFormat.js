// Bound raw fields before escaping: entities and surrogate pairs remain intact.
export const telegramText = (value, fallback = '—', limit = 160) => {
  const raw = (['string','number','boolean'].includes(typeof value) ? String(value).trim() : '') || fallback;
  const points = Array.from(raw);
  return (points.length > limit ? points.slice(0, limit - 1).join('') + '…' : raw)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
};
export const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const telegramMoney = value => new Intl.NumberFormat('ru-RU', {maximumFractionDigits:2})
  .format(finiteNumber(value)).replace(/[\u00a0\u202f]/g, ' ') + ' so‘m';
export const telegramHeader = title => `<b>ZENIX POS BOT</b>\n\n${title}\n\n━━━━━━━━━━━━\n\n`;
export const telegramTime = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Tashkent', day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
};
