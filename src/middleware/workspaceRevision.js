import { pool } from "../db/pool.js";
import { bumpWorkspaceRevision, shouldBumpWorkspaceRevision } from "../lib/workspaceRevision.js";

export const createWorkspaceRevisionMiddleware=({db=pool,bump=bumpWorkspaceRevision,logger=console}={})=>(req,res,next)=>{
  res.once("finish",()=>{
    if(/^\/api\/ai(?:\/|$)/.test(String(req.originalUrl||'').split('?')[0]))return;
    const organizationId=req.user?.organizationId;
    if(!shouldBumpWorkspaceRevision({method:req.method,statusCode:res.statusCode,organizationId}))return;
    Promise.resolve(bump(db,organizationId)).catch((error)=>{
      logger.error("[workspace revision] bump failed",error);
    });
  });
  next();
};

export const workspaceRevisionMiddleware=createWorkspaceRevisionMiddleware();
