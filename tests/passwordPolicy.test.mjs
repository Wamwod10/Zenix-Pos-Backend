import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {newPasswordSchema,passwordRotationThrottleKey} from '../src/lib/passwordPolicy.js';
test('new credentials reject bcrypt truncation for ASCII and multi-byte passwords',()=>{
 const schema=newPasswordSchema(8);
 assert.equal(schema.safeParse('a'.repeat(72)).success,true);
 assert.equal(schema.safeParse('a'.repeat(73)).success,false);
 assert.equal(schema.safeParse('ў'.repeat(36)).success,true);
 assert.equal(schema.safeParse('ў'.repeat(37)).success,false);
 assert.equal(newPasswordSchema(12).safeParse('short123').success,false);
 assert.equal(bcrypt.truncates('ў'.repeat(37)),true);
});
test('rotation attempt keys cannot collide with permitted login names',()=>{
 const a=passwordRotationThrottleKey('a'),b=passwordRotationThrottleKey('b');
 assert.ok(a.length>120);assert.notEqual(a,b);
});
