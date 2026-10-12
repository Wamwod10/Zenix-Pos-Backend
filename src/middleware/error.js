import { ZodError } from "zod";
import { HttpError } from "../lib/http.js";

const constraintMessages = {
  products_org_sku_unique: "Bu SKU allaqachon mavjud",
  products_org_barcode_unique: "Bu shtrix-kod allaqachon mavjud",
  users_org_username_unique: "Bu kirish nomi allaqachon mavjud",
  users_username_global_unique: "Bu kirish nomi allaqachon mavjud",
  users_org_phone_unique: "Bu telefon raqami boshqa faol xodimga biriktirilgan",
  suppliers_org_phone_unique: "Bu telefon raqami boshqa faol ta’minotchiga biriktirilgan",
  product_serials_org_serial_ci_unique: "Bu Serial/IMEI allaqachon mavjud",
  product_serials_organization_id_serial_key: "Bu Serial/IMEI allaqachon mavjud",
};

export function notFound(req, res) {
  res.status(404).json({ ok:false, error:{ code:"NOT_FOUND", message:"Endpoint topilmadi" } });
}

const validationDetails=(error)=>error.issues?.map((issue)=>({
  path:Array.isArray(issue.path)?issue.path.join("."):"",
  message:issue.message,
  code:issue.code,
}))||[];

export function errorHandler(error, req, res, _next) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      ok:false,
      error:{ code:"VALIDATION_ERROR", message:"Yuborilgan ma’lumotlarni tekshiring", details:validationDetails(error) },
    });
  }
  if (error?.type === "entity.parse.failed" || (error instanceof SyntaxError && Number(error?.status) === 400)) {
    return res.status(400).json({ ok:false, error:{ code:"INVALID_JSON", message:"So‘rov JSON formati noto‘g‘ri" } });
  }
  if (error?.type === "entity.too.large" || Number(error?.status) === 413) {
    return res.status(413).json({ ok:false, error:{ code:"PAYLOAD_TOO_LARGE", message:"Yuborilgan ma’lumot hajmi ruxsat etilgan limitdan katta" } });
  }
  if (error?.code === "23505") {
    const message = constraintMessages[error.constraint] || "Bu qiymat allaqachon mavjud";
    const code = ["users_org_username_unique", "users_username_global_unique"].includes(error.constraint) ? "USERNAME_EXISTS" : "DUPLICATE";
    return res.status(409).json({ ok:false, error:{ code, message } });
  }
  if (error?.code === "23503") return res.status(409).json({ ok:false, error:{ code:"DEPENDENCY", message:"Bog‘liq ma’lumot mavjudligi sabab amalni bajarib bo‘lmadi" } });
  if (error?.code === "23514" || error?.code === "23502") {
    return res.status(400).json({ ok:false, error:{ code:"INVALID_DATA", message:"Ma’lumot biznes qoidalariga mos emas" } });
  }
  if (error?.code === "22P02") {
    return res.status(400).json({ ok:false, error:{ code:"INVALID_IDENTIFIER", message:"Noto‘g‘ri identifikator yuborildi" } });
  }
  const status = error instanceof HttpError ? error.status : (Number.isInteger(error?.status)&&error.status>=400&&error.status<600?error.status:500);
  const code = error instanceof HttpError ? error.code : (status<500&&error?.code?String(error.code):"INTERNAL_ERROR");
  const message = error instanceof HttpError ? error.message : (status<500&&error?.message?String(error.message):"Serverda kutilmagan xatolik yuz berdi");
  if (status >= 500) console.error(JSON.stringify({event:"unhandled_api_error",requestId:req.requestId||null,method:req.method,status,errorCode:String(error?.code||"INTERNAL_ERROR").slice(0,40)}));
  return res.status(status).json({ ok:false, error:{ code, message, details:error.details } });
}
