const partsInZone=(value,timeZone)=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
  timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",
}).formatToParts(value).map((part)=>[part.type,part.value]));

const shiftISODate=(dateISO,days)=>{
  const date=new Date(`${dateISO}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
};

export function databaseDateISO(value){
  if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}/.test(value))return value.slice(0,10);
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))throw new Error("Invalid database date value");
  const pad=(part)=>String(part).padStart(2,"0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

export function organizationCalendarDateISO(organization,now=new Date()){
  const timeZone=organization?.timezone||"Asia/Tashkent";
  const parts=partsInZone(now,timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function organizationBusinessDateISO(organization,now=new Date()){
  const timeZone=organization?.timezone||"Asia/Tashkent";
  const startTime=organization?.settings?.workspaceSettings?.businessDay?.startTime||"00:00";
  const [hourRaw,minuteRaw]=String(startTime).split(":");
  const startHour=Math.max(0,Math.min(23,Number(hourRaw||0)));
  const startMinute=Math.max(0,Math.min(59,Number(minuteRaw||0)));
  const parts=partsInZone(now,timeZone);
  const calendarDate=`${parts.year}-${parts.month}-${parts.day}`;
  const currentMinutes=Number(parts.hour||0)*60+Number(parts.minute||0);
  const startMinutes=startHour*60+startMinute;
  return currentMinutes<startMinutes?shiftISODate(calendarDate,-1):calendarDate;
}
