// Strict Gregorian date-only validation; Date.parse alone normalizes or accepts
// formats which the sales API should not accept.
export function isValidCalendarDateISO(value){
 if(typeof value!=="string"||!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+"T12:00:00.000Z");
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}

// A credit receivable cannot be created already overdue. The "today" argument
// must come from the organization's timezone, not the Node process timezone.
export function isAcceptableCreditDueDate(value,today){
 return isValidCalendarDateISO(value)&&isValidCalendarDateISO(today)&&value>=today;
}
