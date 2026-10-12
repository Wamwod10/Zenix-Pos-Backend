import {aiSettings} from '../config/ai.js';
import {recoverAiLeases} from './aiQuota.js';
export function startAiMaintenance(settings=aiSettings()){
 let pending=null;
 const run=()=>{if(!pending)pending=recoverAiLeases({}).catch(()=>console.warn(JSON.stringify({event:'ai_accounting_cleanup_failed'}))).finally(()=>{pending=null})};
 const timer=settings.enabled?setInterval(run,60000):null;timer?.unref();
 return {async stop(){if(timer)clearInterval(timer);if(pending)await pending}};
}
