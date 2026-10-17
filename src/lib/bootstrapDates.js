// Reuse ICU formatters during one bootstrap response, without a global tenant cache.
export function createBootstrapDateParts(timeZone='Asia/Tashkent') {
  const iso=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const display=new Intl.DateTimeFormat('uz-UZ',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'});
  const clock=new Intl.DateTimeFormat('uz-UZ',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false});
  return value=>{
    const date=value?new Date(value):new Date();
    return {dateISO:iso.format(date),date:display.format(date),time:clock.format(date)};
  };
}
