import {z} from 'zod';
import {HttpError} from './http.js';

const packagingSchema=z.array(z.object({unit:z.enum(['dona','blok','quti','pachka']),factor:z.coerce.number().min(0.001).max(1000000).refine(value=>Number(value.toFixed(3))===value,'Qadoq koeffitsiyenti 3 kasr xonadan oshmasin'),salePrice:z.coerce.number().min(0).max(1000000000000)})).max(20);
export function validateProductMetadata(metadata={}){
  if(metadata.packaging!==undefined){
    const rows=packagingSchema.parse(metadata.packaging);
    if(new Set(rows.map(row=>row.unit)).size!==rows.length)throw new HttpError(400,'Qadoq birliklari takrorlanmasin','INVALID_PACKAGING');
  }
  for(const value of [metadata.manufacturedDate,metadata.expiryDate])if(value)z.string().date().parse(value);
  if(metadata.manufacturedDate&&metadata.expiryDate&&metadata.expiryDate<metadata.manufacturedDate)throw new HttpError(400,'Yaroqlilik sanasi ishlab chiqarilgan sanadan oldin','INVALID_EXPIRY_DATE');
  if(metadata.trackingMode!==undefined)z.enum(['none','serial','imei']).parse(metadata.trackingMode);
  return metadata;
}
