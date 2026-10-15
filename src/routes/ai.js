import {Router} from 'express';
import {requireAuth,requireOrganization} from '../middleware/auth.js';
import {ok,asyncRoute,HttpError} from '../lib/http.js';
import {hasPermission} from '../lib/permissions.js';
import {aiRuntimeSettings} from '../config/ai.js';
import {AI_SUGGESTIONS,allowedTopics} from '../services/aiPolicy.js';
import {aiStatus} from '../services/aiQuota.js';
import {aiChat} from '../services/aiChat.js';
import {createAiAgentProvider} from '../services/aiAgentProvider.js';
import {confirmAgentAction,cancelAgentAction,getAgentActionStatus} from '../services/aiAgentActions.js';
export function createAiRouter({settings=aiRuntimeSettings(),provider=createAiAgentProvider(settings)}={}){
 const router=Router();router.use(requireAuth,requireOrganization,(req,_res,next)=>allowedTopics(req.user).length||hasPermission(req.user,'moduleProducts')||hasPermission(req.user,'moduleInventory')?next():next(new HttpError(403,'AI uchun ma’lumot ruxsati yo‘q','AI_FORBIDDEN')));
 router.get('/status',asyncRoute(async(req,res)=>{const status=await aiStatus(req.user,settings);if(!hasPermission(req.user,'moduleBilling'))delete status.statistics;ok(res,{...status,writesEnabled:Boolean(settings.enabled&&settings.writesEnabled),suggestions:allowedTopics(req.user).map(topic=>({topic,question:AI_SUGGESTIONS[topic]}))})}));
 router.post('/chat',asyncRoute(async(req,res)=>ok(res,await aiChat(req.user,req.body,{settings,provider}))));
 router.post('/actions/:id/confirm',asyncRoute(async(req,res)=>ok(res,(await confirmAgentAction(req.user,req.params.id,req.body,{settings})).action)));
 router.post('/actions/:id/cancel',asyncRoute(async(req,res)=>ok(res,(await cancelAgentAction(req.user,req.params.id,req.body,{settings})).action)));
 router.get('/actions/:id/status',asyncRoute(async(req,res)=>ok(res,(await getAgentActionStatus(req.user,req.params.id,{settings})).action)));
 return router;
}
export default createAiRouter();
