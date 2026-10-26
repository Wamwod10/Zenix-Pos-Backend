import {HttpError} from './http.js';

export function parseBusinessStartTime(value='00:00'){
 if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new HttpError(400,'Ish kuni boshlanish vaqti HH:mm formatida bo‘lishi kerak','INVALID_BUSINESS_START_TIME');
 return value.split(':').map(Number);
}
export function validateWorkspaceTimeSettings(workspace){
 const timezone=workspace?.organization?.timezone;
 if(timezone!==undefined){
  if(typeof timezone!=='string'||!timezone.trim())throw new HttpError(400,'Vaqt zonasi noto‘g‘ri','INVALID_TIMEZONE');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format()}catch{throw new HttpError(400,'Vaqt zonasi noto‘g‘ri','INVALID_TIMEZONE')}
 }
 for(const settings of [workspace,...Object.values(workspace?.storeOverrides||{})])if(settings?.businessDay?.startTime!==undefined)parseBusinessStartTime(settings.businessDay.startTime);
}
