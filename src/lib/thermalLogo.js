import {createHash} from 'node:crypto';
// Small, embedded thermal PNG only. No SVG, remote URLs, arbitrary MIME or HTML.
// Decode only bounded data and reject large declared raster dimensions.
export function validThermalLogo(value){
 if(value==='')return true;
 if(typeof value!=='string'||value.length>22000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
 const encoded=value.slice(22),bytes=Buffer.from(encoded,'base64');
 if(bytes.length<45||bytes.length>16384||bytes.toString('base64')!==encoded)return false;
 if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')return false;
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 return width>=1&&width<=192&&height>=1&&height<=96&&bytes.subarray(-12).equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]));
}
// Audit logs identify changed logos without persisting the image again on every edit.
export function redactSettingsAuditLogo(settings){
 const workspace=settings?.workspaceSettings;
 if(!workspace||typeof workspace!=='object')return settings;
 const redact=receipt=>receipt&&typeof receipt.logoData==='string'&&receipt.logoData?{...receipt,logoData:'sha256:'+createHash('sha256').update(receipt.logoData).digest('hex')}:receipt;
 const overrides=Object.fromEntries(Object.entries(workspace.storeOverrides||{}).map(([id,row])=>[id,row?.receipt?{...row,receipt:redact(row.receipt)}:row]));
 return {...settings,workspaceSettings:{...workspace,...(workspace.receipt?{receipt:redact(workspace.receipt)}:{}),...(workspace.storeOverrides?{storeOverrides:overrides}:{})}};
}
