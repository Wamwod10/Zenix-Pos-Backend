import {Router} from 'express';
import {requireAuth,requireOrganization} from '../middleware/auth.js';
import {ok,asyncRoute,HttpError} from '../lib/http.js';
import {hasPermission} from '../lib/permissions.js';
import {aiSettings} from '../config/ai.js';
import {AI_SUGGESTIONS,allowedTopics} from '../services/aiPolicy.js';
import {aiStatus} from '../services/aiQuota.js';
import {aiChat} from '../services/aiChat.js';
import {createAiProvider} from '../services/aiProvider.js';
export function createAiRouter({settings=aiSettings(),provider=createAiProvider(settings)}={}){
 const router=Router();router.use(requireAuth,requireOrganization,(req,_res,next)=>allowedTopics(req.user).length?next():next(new HttpError(403,'AI uchun ma’lumot ruxsati yo‘q','AI_FORBIDDEN')));
 router.get('/status',asyncRoute(async(req,res)=>{const status=await aiStatus(req.user,settings);if(!hasPermission(req.user,'moduleBilling'))delete status.statistics;ok(res,{...status,suggestions:allowedTopics(req.user).map(topic=>({topic,question:AI_SUGGESTIONS[topic]}))})}));
 router.post('/chat',asyncRoute(async(req,res)=>ok(res,await aiChat(req.user,req.body,{settings,provider}))));
 return router;
}
export default createAiRouter();
