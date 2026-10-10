import { z } from 'zod';
import { likeTerm } from './platformDirectory.js';

const querySchema=z.object({
  q:z.string().trim().max(100).default(''),
  filter:z.enum(['all','debtors','overdue','vip','regular','active','inactive']).default('all'),
  sort:z.enum(['name','spend','debt','overdue','latest','newest','frequency']).default('name'),
  direction:z.enum(['asc','desc']).default('asc'),
  limit:z.coerce.number().int().min(1).max(100).default(30),
  offset:z.coerce.number().int().min(0).max(1000000).default(0),
  tags:z.preprocess(value=>typeof value==='string'?value.split(',').map(x=>x.trim()).filter(Boolean):value,z.array(z.string().trim().min(1).max(40)).max(20).default([])),
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
  LEFT JOIN (SELECT customer_id,sum(GREATEST(total-returned_amount,0)) total_purchases,count(*) sale_count,max(created_at) last_purchase_at
    FROM sales WHERE organization_id=$1 AND customer_id IS NOT NULL GROUP BY customer_id) s ON s.customer_id=c.id
  LEFT JOIN (SELECT customer_id,sum(points) loyalty_points FROM customer_loyalty_ledger
    WHERE organization_id=$1 GROUP BY customer_id) lp ON lp.customer_id=c.id`;

const filters={all:'true',debtors:'c.balance>0',overdue:'c.overdue>0',vip:"c.customer_type='VIP'",regular:"c.customer_type='REGULAR'",active:'c.archived=false',inactive:'c.archived=true'};
const sorts={name:'lower(c.name)',spend:'c.total_purchases',debt:'c.balance',overdue:'c.overdue',latest:'c.last_purchase_at',newest:'c.created_at',frequency:'c.sale_count'};

export function buildCustomerPageQuery(input){
  const {organizationId,...rawQuery}=input;
  z.string().uuid().parse(organizationId);
  const query=parseCustomerDirectoryQuery(rawQuery);
  const order=`${sorts[query.sort]} ${query.direction==='desc'?'DESC':'ASC'} NULLS LAST,c.id ASC`;
  return {
    // Materialize each tenant aggregate once. A FULL JOIN fence prevents quadratic
    // nested-loop rescans when a new tenant has not reached the autovacuum statistics threshold.
    // Unmatched financial rows are removed by filtered; only authorized customers remain.
    text:`WITH allocations AS MATERIALIZED (SELECT credit_ledger_id,sum(amount) allocated FROM customer_payment_allocations WHERE organization_id=$1 GROUP BY credit_ledger_id),
    events AS (
      SELECT customer_id,amount balance,0::numeric overdue,0::numeric total_purchases,0::bigint sale_count,NULL::timestamptz last_purchase_at,0::numeric loyalty_points FROM customer_ledger WHERE organization_id=$1
      UNION ALL SELECT cl.customer_id,0,GREATEST(cl.amount-COALESCE(a.allocated,0),0),0,0,NULL,0 FROM customer_ledger cl LEFT JOIN allocations a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.entry_type='CREDIT_SALE' AND cl.due_date<CURRENT_DATE
      UNION ALL SELECT customer_id,0,0,GREATEST(total-returned_amount,0),1,created_at,0 FROM sales WHERE organization_id=$1 AND customer_id IS NOT NULL
      UNION ALL SELECT customer_id,0,0,0,0,NULL,points FROM customer_loyalty_ledger WHERE organization_id=$1
    ), finance AS MATERIALIZED (SELECT customer_id,sum(balance) balance,sum(overdue) overdue,sum(total_purchases) total_purchases,sum(sale_count) sale_count,max(last_purchase_at) last_purchase_at,sum(loyalty_points) loyalty_points FROM events GROUP BY customer_id),
    directory AS MATERIALIZED (
      SELECT c.*,COALESCE(f.balance,0) balance,COALESCE(f.overdue,0) overdue,COALESCE(f.total_purchases,0) total_purchases,COALESCE(f.sale_count,0) sale_count,f.last_purchase_at,COALESCE(f.loyalty_points,0) loyalty_points
      FROM (SELECT * FROM customers c WHERE c.organization_id=$1 AND c.archived=${query.filter==='inactive'?'true':'false'} AND ($2='%%' OR name ILIKE $2 ESCAPE E'\\\\' OR phone ILIKE $2 ESCAPE E'\\\\' OR email ILIKE $2 ESCAPE E'\\\\')) c FULL JOIN finance f ON f.customer_id=c.id
    ), filtered AS MATERIALIZED (SELECT * FROM directory c WHERE c.id IS NOT NULL AND ${filters[query.filter]} AND c.tags @> $5::text[])
    SELECT c.*,totals.total FROM (SELECT count(*)::int AS total FROM filtered) totals LEFT JOIN (SELECT * FROM filtered c ORDER BY ${order} LIMIT $3 OFFSET $4) c ON true ORDER BY ${order}`,
    values:[organizationId,likeTerm(query.q),query.limit,query.offset,query.tags],
  };
}

const historySchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1000000).default(0),storeId:z.string().uuid().optional()}).strict();
export const parseCustomerHistoryQuery=value=>historySchema.parse(value);
export function buildCustomerHistoryQuery({organizationId,customerId,storeId=null,kind,limit=50,offset=0}){
 z.string().uuid().parse(organizationId);z.string().uuid().parse(customerId);
 if(storeId)z.string().uuid().parse(storeId);
 const page=parseCustomerHistoryQuery({limit,offset});
 const values=[organizationId,customerId,storeId,page.limit+1,page.offset];
 if(kind==='sales')return {text:`SELECT s.* FROM sales s WHERE s.organization_id=$1 AND s.customer_id=$2 AND ($3::uuid IS NULL OR s.store_id=$3) ORDER BY s.created_at DESC,s.id DESC LIMIT $4 OFFSET $5`,values};
 if(kind==='returns')return {text:`SELECT r.*,s.sale_number,p.name product_name FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id LEFT JOIN products p ON p.id=r.product_id AND p.organization_id=r.organization_id WHERE r.organization_id=$1 AND s.customer_id=$2 AND ($3::uuid IS NULL OR s.store_id=$3) ORDER BY r.created_at DESC,r.id DESC LIMIT $4 OFFSET $5`,values};
 if(!['ledger','open-credits'].includes(kind))throw new Error('Unknown customer history');
 return {text:`SELECT cl.*,COALESCE(a.allocated,0) allocated FROM customer_ledger cl LEFT JOIN (SELECT credit_ledger_id,sum(amount) allocated FROM customer_payment_allocations WHERE organization_id=$1 AND customer_id=$2 GROUP BY credit_ledger_id) a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.customer_id=$2 AND ($3::uuid IS NULL OR cl.store_id=$3) ${kind==='open-credits'?"AND cl.entry_type='CREDIT_SALE' AND cl.amount-COALESCE(a.allocated,0)>0":''} ORDER BY cl.created_at DESC,cl.id DESC LIMIT $4 OFFSET $5`,values};
}
