import { pool } from "../db/pool.js";
import { env } from "../config/env.js";
import { sha256 } from "../lib/crypto.js";
import { HttpError } from "../lib/http.js";
import { hasPermission } from "../lib/permissions.js";

export async function requireAuth(req, _res, next) {
  try {
    const raw = req.cookies?.[env.sessionCookieName];
    if (!raw) throw new HttpError(401, "Avval tizimga kiring", "UNAUTHENTICATED");
    const tokenHash = sha256(raw);
    const { rows } = await pool.query(`
      SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id, u.organization_id, u.store_id, u.name, u.username, u.phone,
             u.app_role, u.permission_overrides, u.active, o.name AS organization_name, o.license_status, o.expiry_date, o.timezone AS organization_timezone,
             CASE WHEN o.expiry_date IS NULL THEN true ELSE o.expiry_date >= (now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::date END AS license_date_valid,
             o.settings AS organization_settings
      FROM auth_sessions s
      JOIN users u ON u.id=s.user_id
      LEFT JOIN organizations o ON o.id=u.organization_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
      LIMIT 1`, [tokenHash]);
    const row = rows[0];
    if (!row || row.active === false) throw new HttpError(401, "Sessiya yakunlangan", "SESSION_EXPIRED");
    req.user = {
      id:row.id, organizationId:row.organization_id, storeId:row.store_id, name:row.name, username:row.username,
      phone:row.phone, appRole:row.app_role, permissionOverrides:row.permission_overrides || {}, organizationName:row.organization_name,
      sessionId:row.session_id, licenseStatus:row.license_status, expiryDate:row.expiry_date, organizationTimezone:row.organization_timezone,
      licenseDateValid:row.license_date_valid!==false,
      rolePermissions:row.organization_settings?.rolePermissions || {},
    };
    const lastSeenAt=row.last_seen_at?new Date(row.last_seen_at).getTime():0;
    if(!lastSeenAt||Date.now()-lastSeenAt>60_000){
      pool.query("UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]).catch(()=>{});
    }
    next();
  } catch (error) { next(error); }
}

export const requirePermission = (permission) => (req, _res, next) => {
  if (!hasPermission(req.user, permission)) return next(new HttpError(403, "Bu amal uchun ruxsat yetarli emas", "FORBIDDEN"));
  next();
};

export const requireOrganization = (req, _res, next) => {
  if (!req.user?.organizationId) return next(new HttpError(403, "Tashkilot konteksti topilmadi", "NO_ORGANIZATION"));
  next();
};

export const requireActiveLicense = (req, _res, next) => {
  const status = String(req.user?.licenseStatus || "PAYMENT_REQUIRED").toUpperCase();
  const dateValid = req.user?.licenseDateValid !== false;
  const active = (status === "ACTIVE" || status === "APPROVED") && dateValid;
  if (!active) return next(new HttpError(402, "Zenix POS tarifini faollashtiring", status === "REVIEW" ? "LICENSE_REVIEW" : status === "EXPIRED" || !dateValid ? "LICENSE_EXPIRED" : "PAYMENT_REQUIRED"));
  next();
};
