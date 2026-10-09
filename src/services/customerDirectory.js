import { z } from 'zod';
import { likeTerm } from './platformDirectory.js';

const querySchema=z.object({
  q:z.string().trim().max(100).default(''),
  filter:z.enum(['all','debtors','overdue','vip']).default('all'),
  sort:z.enum(['name','spend','debt','overdue']).default('name'),
  direction:z.enum(['asc','desc']).default('asc'),
  limit:z.coerce.number().int().min(1).max(100).default(30),
  offset:z.coerce.number().int().min(0).max(1000000).default(0),
}).strict();

export function parseCustomerDirectoryQuery(searchParams){
  return querySchema.parse(searchParams instanceof URLSearchParams?Object.fromEntries(searchParams):searchParams);
}

// Each financial source is tenant-scoped before aggregation, including allocations.
export const customerFinancialJoin=`
  LEFT JOIN (SELECT customer_id,sum(amount) balance FROM customer_ledger WHERE organization_id=$1 GROUP BY customer_id) l ON l.customer_id=c.id
  LEFT JOIN (SELECT cl.customer_id,sum(GREATEST(cl.amount-COALESCE(a.allocated,0),0)) overdue
    FROM customer_ledger cl LEFT JOIN (SELECT credit_ledger_id,sum(amount) allocated
      FROM customer_payment_allocations WHERE organization_id=$1 GROUP BY credit_ledger_id) a ON a.credit_ledger_id=cl.id
    WHERE cl.organization_id=$1 AND cl.entry_type='CREDIT_SALE' AND cl.due_date<CURRENT_DATE GROUP BY cl.customer_id) od ON od.customer_id=c.id
  LEFT JOIN (SELECT customer_id,sum(total) total_purchases,count(*) sale_count,max(created_at) last_purchase_at
    FROM sales WHERE organization_id=$1 AND customer_id IS NOT NULL GROUP BY customer_id) s ON s.customer_id=c.id
  LEFT JOIN (SELECT customer_id,sum(points) loyalty_points FROM customer_loyalty_ledger
    WHERE organization_id=$1 GROUP BY customer_id) lp ON lp.customer_id=c.id`;

const filters={all:'true',debtors:'c.balance>0',overdue:'c.overdue>0',vip:"c.customer_type='VIP'"};
const sorts={name:'lower(c.name)',spend:'c.total_purchases',debt:'c.balance',overdue:'c.overdue'};

export function buildCustomerPageQuery(input){
  const {organizationId,...rawQuery}=input;
  z.string().uuid().parse(organizationId);
  const query=parseCustomerDirectoryQuery(rawQuery);
  const order=`${sorts[query.sort]} ${query.direction==='desc'?'DESC':'ASC'},c.id ASC`;
  return {
    text:`WITH directory AS (
      SELECT c.*,COALESCE(l.balance,0) balance,COALESCE(od.overdue,0) overdue,
        COALESCE(s.total_purchases,0) total_purchases,COALESCE(s.sale_count,0) sale_count,
        s.last_purchase_at,COALESCE(lp.loyalty_points,0) loyalty_points
      FROM customers c ${customerFinancialJoin}
      WHERE c.organization_id=$1 AND c.archived=false
        AND ($2='%%' OR c.name ILIKE $2 ESCAPE '\\' OR c.phone ILIKE $2 ESCAPE '\\' OR c.email ILIKE $2 ESCAPE '\\')
    ), filtered AS MATERIALIZED (SELECT * FROM directory c WHERE ${filters[query.filter]})
    SELECT c.*,totals.total FROM (SELECT count(*)::int AS total FROM filtered) totals
      LEFT JOIN (SELECT * FROM filtered c ORDER BY ${order} LIMIT $3 OFFSET $4) c ON true
    ORDER BY ${order}`,
    values:[organizationId,likeTerm(query.q),query.limit,query.offset],
  };
}
