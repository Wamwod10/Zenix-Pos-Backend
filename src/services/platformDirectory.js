import { z } from 'zod';

const basePageSchema = z.object({
  q: z.string().trim().max(100).default(''),
  status: z.string().max(32).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

export const organizationPageSchema = basePageSchema.extend({
  status: z.enum(['all','ACTIVE','EXPIRED','SUSPENDED','PAYMENT_REQUIRED','REVIEW','REJECTED']).default('all'),
});
export const paymentPageSchema = basePageSchema.extend({
  status: z.enum(['all','REVIEW','APPROVED','REJECTED']).default('all'),
});

// Escape SQL LIKE operators: a search query is always a literal substring.
export function likeTerm(query){
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

// A license can expire by calendar date without any background job changing the
// stored status. All platform totals, filters and rows must agree with the
// auth middleware's business-timezone expiry decision.
export const effectiveLicenseStatusSql = () => `CASE
  WHEN o.license_status IN ('ACTIVE','APPROVED')
    AND o.expiry_date IS NOT NULL
    AND o.expiry_date < (now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::date
  THEN 'EXPIRED' ELSE o.license_status END`;

export function organizationPageSql(input){
  const values=[likeTerm(input.q),input.status];
  const from=`FROM organizations o
    LEFT JOIN LATERAL (
      SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER'
      ORDER BY u.created_at ASC,u.id ASC LIMIT 1
    ) owner ON true`;
  const effectiveStatus=effectiveLicenseStatusSql();
  const where=`WHERE ($1='%%' OR o.name ILIKE $1 ESCAPE '\\' OR owner.name ILIKE $1 ESCAPE '\\' OR owner.phone ILIKE $1 ESCAPE '\\' OR o.phone ILIKE $1 ESCAPE '\\')
    AND ($2='all' OR (${effectiveStatus})=$2)`;
  return {
    countSql:`SELECT count(*)::int AS total ${from} ${where}`,
    rowsSql:`SELECT o.id,o.name,o.phone,o.plan,${effectiveStatus} AS license_status,o.expiry_date,o.store_limit,o.created_at,
      owner.name AS owner_name,owner.phone AS owner_phone,
      (SELECT count(*)::int FROM stores st WHERE st.organization_id=o.id AND st.active=true) AS store_count
      ${from} ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT $3 OFFSET $4`,
    countParams:values,rowsParams:[...values,input.limit,input.offset],
  };
}

export function paymentPageSql(input){
  const values=[likeTerm(input.q),input.status];
  const from=`FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id
    LEFT JOIN billing_drafts bd ON bd.id=bp.draft_id`;
  const where=`WHERE ($1='%%' OR o.name ILIKE $1 ESCAPE '\\' OR bp.order_id ILIKE $1 ESCAPE '\\' OR bp.id::text ILIKE $1 ESCAPE '\\')
    AND ($2='all' OR bp.status=$2)`;
  return {
    countSql:`SELECT count(*)::int AS total ${from} ${where}`,
    rowsSql:`SELECT bp.*,o.name AS organization_name,bd.metadata->>'intent' AS draft_intent
      ${from} ${where} ORDER BY bp.submitted_at DESC,bp.id DESC LIMIT $3 OFFSET $4`,
    countParams:values,rowsParams:[...values,input.limit,input.offset],
  };
}

export async function fetchDirectoryPage(db,query){
  const [rows,total]=await Promise.all([
    db.query(query.rowsSql,query.rowsParams),
    db.query(query.countSql,query.countParams),
  ]);
  return {rows:rows.rows,total:Number(total.rows[0]?.total||0)};
}
