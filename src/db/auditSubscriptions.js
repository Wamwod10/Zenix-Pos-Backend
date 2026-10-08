import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only launch gate. Do not rewrite legacy licenses or alter production data.
export async function auditSubscriptionIntegrity(db) {
  const [licenseRows, limitRows] = await Promise.all([
    db.query(`SELECT
      count(*) FILTER (WHERE license_status IN ('ACTIVE','APPROVED') AND expiry_date IS NULL)::int AS active_without_expiry,
      count(*) FILTER (WHERE license_status IN ('ACTIVE','APPROVED') AND expiry_date IS NOT NULL
        AND expiry_date < (now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'Asia/Tashkent'))::date)::int AS stored_active_but_expired
      FROM organizations`),
    db.query(`SELECT count(*)::int AS over_limit_organizations FROM (
      SELECT o.id FROM organizations o
      LEFT JOIN stores s ON s.organization_id=o.id AND s.active=true
      GROUP BY o.id,o.store_limit HAVING count(s.id)>o.store_limit
    ) over_limit`),
  ]);
  const activeWithoutExpiry=Number(licenseRows.rows[0]?.active_without_expiry || 0);
  const storedActiveButExpired=Number(licenseRows.rows[0]?.stored_active_but_expired || 0);
  const overLimitOrganizations=Number(limitRows.rows[0]?.over_limit_organizations || 0);
  return {
    ok: activeWithoutExpiry===0 && overLimitOrganizations===0,
    blockers: { activeWithoutExpiry, overLimitOrganizations },
    information: { storedActiveButExpired },
  };
}

const isMain=process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){
  const {pool}=await import('./pool.js');
  try {
    const report=await auditSubscriptionIntegrity(pool);
    console.log(JSON.stringify(report,null,2));
    if(!report.ok)process.exitCode=1;
  }catch(error){
    console.error(`[db:audit-subscriptions] failed code=${String(error?.code||'UNKNOWN').slice(0,40)}`);
    process.exitCode=1;
  }finally{await pool.end().catch(()=>{});}
}
