import {assertStoreScope,assertOrganizationStore} from '../lib/storeScope.js';
import {hasPermission} from '../lib/permissions.js';
import {HttpError} from '../lib/http.js';
import {posCatalogQuerySchema,decodePosCatalogCursor,encodePosCatalogCursor,mapBootstrapProduct} from '../lib/posCatalog.js';
import {addCatalogSearchFilter} from '../lib/catalogSearch.js';

export async function readPosCatalog(client,user,query){
 if(!['moduleInventory','moduleProducts','moduleSales','moduleDashboard','moduleAnalytics'].some(permission=>hasPermission(user,permission)))throw new HttpError(403,'Catalog access denied','FORBIDDEN');
 const input=posCatalogQuerySchema.parse(query),cursor=decodePosCatalogCursor(input.cursor);
 assertStoreScope(user,input.storeId);
 await assertOrganizationStore(client,user.organizationId,input.storeId,{activeOnly:false});
 const params=[user.organizationId,input.storeId],filters=['p.organization_id=$1'];
 if(input.ids){params.push(input.ids);filters.push(`p.id=ANY($${params.length}::uuid[])`)}else filters.push('p.archived=false');
 const searchFilter=addCatalogSearchFilter(params,input.search);if(searchFilter)filters.push(searchFilter);
 for(const key of ['barcode','category'])if(input[key]){params.push(input[key]);filters.push(`p.${key}=$${params.length}`)}
 if(cursor){params.push(cursor.createdAt,cursor.id);filters.push(`(p.created_at,p.id)<($${params.length-1}::timestamptz,$${params.length}::uuid)`)}
 // IDs always return every requested product, regardless of a browsing page size.
 const limit=input.ids?input.ids.length:input.barcode?1:input.limit;
 params.push(input.barcode?2:limit+1);
 const {rows}=await client.query(`WITH page AS MATERIALIZED (
  SELECT p.*,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at
  FROM products p WHERE ${filters.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT $${params.length}
 ) SELECT p.*,
 jsonb_build_object(($2::uuid)::text,COALESCE((SELECT ib.quantity FROM inventory_balances ib WHERE ib.organization_id=$1 AND ib.store_id=$2 AND ib.product_id=p.id),0)) stock_by_store,
 (SELECT max(s.created_at) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.organization_id=$1 AND s.store_id=$2 AND si.product_id=p.id) last_sale_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ps.id,'serial',ps.serial,'storeId',ps.store_id,'status',ps.status,'receivedAt',ps.created_at,'saleId',ps.sale_id,'transferId',ps.transfer_id) ORDER BY ps.created_at,ps.id) FROM product_serials ps WHERE ps.organization_id=$1 AND ps.store_id=$2 AND ps.product_id=p.id),'[]'::jsonb) serialized_units,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ib.id,'storeId',ib.store_id,'receivedAt',ib.created_at,'invoiceNo',ib.reference_id,'batchNo',ib.batch_no,'manufacturedDate',ib.manufactured_date,'expiryDate',ib.expiry_date,'quantity',ib.received_quantity,'remaining',ib.remaining_quantity,'costPrice',ib.unit_cost) ORDER BY ib.created_at,ib.id) FROM inventory_batches ib WHERE ib.organization_id=$1 AND ib.store_id=$2 AND ib.product_id=p.id AND ib.remaining_quantity>0),'[]'::jsonb) stock_batches
 FROM page p ORDER BY p.created_at DESC,p.id DESC`,params);
 if(input.barcode&&rows.length>1)throw new HttpError(409,'Barcode matches multiple products','AMBIGUOUS_BARCODE');
 const more=!input.ids&&rows.length>limit,page=rows.slice(0,limit);
 const categories=await client.query("SELECT DISTINCT category FROM products WHERE organization_id=$1 AND archived=false AND category<>'' ORDER BY category",[user.organizationId]);
 return {products:page.map(row=>({...mapBootstrapProduct(row),serializedUnits:row.serialized_units||[],stockBatches:row.stock_batches||[]})),hasMore:more,nextCursor:more?encodePosCatalogCursor(page.at(-1)):null,categories:categories.rows.map(row=>row.category),...(input.ids?{missingIds:input.ids.filter(id=>!page.some(row=>row.id===id))}:{})};
}
