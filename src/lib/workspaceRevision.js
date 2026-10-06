const MUTATION_METHODS=new Set(["POST","PATCH","PUT","DELETE"]);

const revisionView=(row={})=>({
  revision:Number(row.revision||0),
  updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null,
});

export const shouldBumpWorkspaceRevision=({method,statusCode,organizationId})=>(
  Boolean(organizationId)
  && MUTATION_METHODS.has(String(method||"").toUpperCase())
  && Number(statusCode)>=200
  && Number(statusCode)<300
);

export async function readWorkspaceRevision(db,organizationId){
  const result=await db.query(
    "SELECT revision,updated_at FROM workspace_revisions WHERE organization_id=$1",
    [organizationId],
  );
  return revisionView(result.rows[0]);
}

export async function bumpWorkspaceRevision(db,organizationId){
  const result=await db.query(`
    INSERT INTO workspace_revisions(organization_id,revision,updated_at)
    VALUES($1,1,now())
    ON CONFLICT(organization_id) DO UPDATE
    SET revision=workspace_revisions.revision+1,updated_at=now()
    RETURNING revision,updated_at`,[organizationId]);
  return revisionView(result.rows[0]);
}
