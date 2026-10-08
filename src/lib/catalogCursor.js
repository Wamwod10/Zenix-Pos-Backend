import { z } from 'zod';
import { HttpError } from './http.js';

const cursorSchema=z.object({createdAt:z.string().datetime({offset:true}),id:z.string().uuid()}).strict();
export const catalogPageQuerySchema=z.object({
  limit:z.coerce.number().int().min(1).max(100).default(50),
  search:z.string().trim().max(120).default(''),
  includeArchived:z.enum(['true','false']).default('false'),
  cursor:z.string().max(512).optional(),
}).strict();

export function encodeCatalogCursor(row){
  return Buffer.from(JSON.stringify({createdAt:new Date(row.created_at).toISOString(),id:row.id}),'utf8').toString('base64url');
}
export function decodeCatalogCursor(value){
  if(!value)return null;
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(value)||value.length>512)throw new Error('invalid cursor');
    return cursorSchema.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));
  }catch{throw new HttpError(400,'Mahsulotlar sahifasi kaliti noto‘g‘ri','INVALID_CATALOG_CURSOR')}
}
