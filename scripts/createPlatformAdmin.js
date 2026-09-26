import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.js";

const username=String(process.env.PLATFORM_ADMIN_USERNAME||"").trim().toLowerCase();
const password=String(process.env.PLATFORM_ADMIN_PASSWORD||"");
const name=String(process.env.PLATFORM_ADMIN_NAME||"Zenix POS Admin").trim()||"Zenix POS Admin";

if(username.length<3)throw new Error("PLATFORM_ADMIN_USERNAME is required (min 3 chars)");
if(password.length<10)throw new Error("PLATFORM_ADMIN_PASSWORD is required (min 10 chars)");

const passwordHash=await bcrypt.hash(password,12);
try{
  const existing=(await pool.query("SELECT * FROM users WHERE lower(username)=lower($1) LIMIT 1",[username])).rows[0];
  if(existing&&existing.app_role!=="PLATFORM_ADMIN")throw new Error("Username is already used by a workspace user");
  if(existing){
    await pool.query("UPDATE users SET name=$2,password_hash=$3,active=true,must_change_password=false,updated_at=now() WHERE id=$1",[existing.id,name,passwordHash]);
    await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[existing.id]);
    console.log(`[platform] admin updated: ${username}`);
  }else{
    await pool.query(`INSERT INTO users(organization_id,store_id,name,username,phone,password_hash,app_role,active,must_change_password)
      VALUES(NULL,NULL,$1,$2,'',$3,'PLATFORM_ADMIN',true,false)`,[name,username,passwordHash]);
    console.log(`[platform] admin created: ${username}`);
  }
}finally{
  await pool.end();
}
