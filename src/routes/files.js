import express,{ Router } from "express";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requireActiveLicense, requirePermission } from "../middleware/auth.js";
import { hasPermission } from "../lib/permissions.js";
import { isAssetContentValid } from "../lib/uploadType.js";

const router=Router();
router.use(requireAuth,requireOrganization);router.use(requireActiveLicense);
const allowedTypes=new Set(["image/jpeg","image/png","image/webp","application/pdf"]);
const maxBytes=8*1024*1024;
const requireFileWrite=(req,_res,next)=>hasPermission(req.user,"expensesWrite")||hasPermission(req.user,"productWrite")?next():next(new HttpError(403,"Bu amal uchun ruxsat yetarli emas","FORBIDDEN"));
const requireFileRead=(req,_res,next)=>hasPermission(req.user,"moduleExpenses")||hasPermission(req.user,"moduleProducts")?next():next(new HttpError(403,"Bu amal uchun ruxsat yetarli emas","FORBIDDEN"));

router.post("/",requireFileWrite,express.raw({type:"*/*",limit:"8mb"}),asyncRoute(async(req,res)=>{
  const content=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
  const mimeType=String(req.headers["content-type"]||"application/octet-stream").split(";")[0].trim().toLowerCase();
  let fileName="file";
  try{fileName=decodeURIComponent(String(req.headers["x-file-name"]||"file")).slice(0,240)||"file"}catch{fileName="file"}
  if(!content.length)throw new HttpError(400,"Fayl bo‘sh","FILE_EMPTY");
  if(content.length>maxBytes)throw new HttpError(413,"Fayl 8 MB dan katta bo‘lmasligi kerak","FILE_TOO_LARGE");
  if(!allowedTypes.has(mimeType))throw new HttpError(415,"Faqat JPG, PNG, WEBP yoki PDF fayllar qo‘llanadi","FILE_TYPE_NOT_ALLOWED");
  if(!isAssetContentValid(content,mimeType))throw new HttpError(415,"Fayl tarkibi ko‘rsatilgan formatga mos kelmaydi","FILE_CONTENT_MISMATCH");
  const {rows}=await pool.query(`INSERT INTO file_assets(organization_id,uploaded_by,file_name,mime_type,file_size,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,file_name,mime_type,file_size,created_at`,[req.user.organizationId,req.user.id,fileName,mimeType,content.length,content]);
  ok(res,{file:{id:rows[0].id,name:rows[0].file_name,type:rows[0].mime_type,size:rows[0].file_size,createdAt:rows[0].created_at}},201);
}));

router.get("/:id",requireFileRead,asyncRoute(async(req,res)=>{
  const row=(await pool.query("SELECT file_name,mime_type,file_size,content FROM file_assets WHERE id=$1 AND organization_id=$2",[req.params.id,req.user.organizationId])).rows[0];
  if(!row)throw new HttpError(404,"Fayl topilmadi","FILE_NOT_FOUND");
  res.setHeader("Content-Type",row.mime_type);
  res.setHeader("Content-Length",String(row.file_size));
  res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
  res.setHeader("Cache-Control","private, max-age=300");
  res.send(row.content);
}));

router.delete("/:id",requireFileWrite,asyncRoute(async(req,res)=>{
  const inUse=(await pool.query(`SELECT 1 FROM expenses WHERE organization_id=$1 AND metadata->>'receiptKey'=$2 UNION ALL SELECT 1 FROM products WHERE organization_id=$1 AND metadata->>'imageKey'=$2 LIMIT 1`,[req.user.organizationId,req.params.id])).rowCount>0;
  if(inUse)throw new HttpError(409,"Fayl amaldagi yozuvda ishlatilmoqda","FILE_IN_USE");
  const result=await pool.query("DELETE FROM file_assets WHERE id=$1 AND organization_id=$2",[req.params.id,req.user.organizationId]);
  if(!result.rowCount)throw new HttpError(404,"Fayl topilmadi","FILE_NOT_FOUND");
  ok(res,{deleted:true});
}));

export default router;
