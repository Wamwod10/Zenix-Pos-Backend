import {z} from 'zod';
// bcrypt silently ignores bytes beyond 72, not characters. Restrict only NEW
// credentials; existing legacy passwords remain usable for login/rotation.
export const newPasswordSchema=(min=8)=>z.string().min(min).max(300).refine(value=>Buffer.byteLength(value,'utf8')<=72,{message:'Parol UTF-8 formatida 72 baytdan oshmasligi kerak'});
// An internal namespace longer than any permitted login name cannot collide
// with a user's actual login attempts. Account key survives IP/device changes.
export const passwordRotationThrottleKey=userId=>'zenix:credential-rotation:'.padEnd(121,':')+String(userId);
