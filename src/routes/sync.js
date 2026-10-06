import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncRoute, ok } from "../lib/http.js";
import { readWorkspaceRevision } from "../lib/workspaceRevision.js";
import { requireActiveLicense, requireAuth, requireOrganization } from "../middleware/auth.js";

const router=Router();
router.use(requireAuth,requireOrganization,requireActiveLicense);

router.get("/version",asyncRoute(async(req,res)=>{
  ok(res,await readWorkspaceRevision(pool,req.user.organizationId));
}));

export default router;
