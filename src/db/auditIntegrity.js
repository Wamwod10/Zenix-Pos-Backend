import path from "node:path";
import { pathToFileURL } from "node:url";
import { REQUIRED_TENANT_CONSTRAINTS } from "./verifySchema.js";

const quoteIdentifier=(value)=>`"${String(value).replaceAll('"','""')}"`;
const quoteLiteral=(value)=>`'${String(value).replaceAll("'","''")}'`;

const constraintCatalogSql=`SELECT constraint_row.conname AS constraint_name,
  child_table.relname AS child_table,
  parent_table.relname AS parent_table,
  array_agg(child_column.attname ORDER BY key_row.position) AS child_columns,
  array_agg(parent_column.attname ORDER BY key_row.position) AS parent_columns
FROM pg_constraint constraint_row
JOIN pg_class child_table ON child_table.oid=constraint_row.conrelid
JOIN pg_class parent_table ON parent_table.oid=constraint_row.confrelid
JOIN LATERAL unnest(constraint_row.conkey,constraint_row.confkey)
  WITH ORDINALITY AS key_row(child_number,parent_number,position) ON true
JOIN pg_attribute child_column ON child_column.attrelid=constraint_row.conrelid AND child_column.attnum=key_row.child_number
JOIN pg_attribute parent_column ON parent_column.attrelid=constraint_row.confrelid AND parent_column.attnum=key_row.parent_number
WHERE constraint_row.connamespace='public'::regnamespace
  AND constraint_row.conname=ANY($1::text[])
GROUP BY constraint_row.conname,child_table.relname,parent_table.relname`;

const buildIntegritySql=(relationships)=>relationships.map((relationship)=>{
  const childColumns=relationship.child_columns.map(quoteIdentifier);
  const parentColumns=relationship.parent_columns.map(quoteIdentifier);
  if(childColumns.length!==parentColumns.length||!childColumns.length){
    throw new Error(`Invalid tenant constraint metadata: ${relationship.constraint_name}`);
  }
  const join=childColumns.map((column,index)=>`p.${parentColumns[index]}=c.${column}`).join(" AND ");
  const referenced=childColumns.map((column)=>`c.${column} IS NOT NULL`).join(" AND ");
  return `SELECT ${quoteLiteral(relationship.constraint_name)} AS check_name,count(*)::bigint AS violations
    FROM ${quoteIdentifier(relationship.child_table)} c
    LEFT JOIN ${quoteIdentifier(relationship.parent_table)} p ON ${join}
    WHERE ${referenced} AND p.${parentColumns[0]} IS NULL`;
}).join("\nUNION ALL\n");

export async function auditTenantIntegrity(db){
  const metadata=(await db.query(constraintCatalogSql,[REQUIRED_TENANT_CONSTRAINTS])).rows;
  const byName=new Map(metadata.map((row)=>[row.constraint_name,row]));
  const missing=REQUIRED_TENANT_CONSTRAINTS.filter((name)=>!byName.has(name));
  if(missing.length)throw new Error(`Tenant integrity constraints missing from database: ${missing.join(", ")}`);
  const ordered=REQUIRED_TENANT_CONSTRAINTS.map((name)=>byName.get(name));
  const {rows}=await db.query(buildIntegritySql(ordered));
  return Object.fromEntries(rows.map((row)=>[row.check_name,Number(row.violations||0)]));
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){
  const {pool}=await import("./pool.js");
  try{
    const checks=await auditTenantIntegrity(pool);
    const violations=Object.values(checks).reduce((sum,value)=>sum+value,0);
    console.log(JSON.stringify({ok:violations===0,violations,checks},null,2));
    if(violations)process.exitCode=1;
  }catch(error){
    const code=typeof error?.code==="string"?` code=${error.code}`:"";
    console.error(`[db:audit-integrity] failed${code}`);
    process.exitCode=1;
  }finally{
    await pool.end().catch(()=>{});
  }
}
