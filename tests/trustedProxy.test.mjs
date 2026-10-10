import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRuntimeEnvironment} from '../src/config/env.js';
test('production trusts no forwarded IP unless explicit bounded proxy addresses are configured',()=>{
 const input={NODE_ENV:'production',DATABASE_URL:'postgres://placeholder/db'};
 assert.equal(parseRuntimeEnvironment(input).trustedProxies,false);
 assert.deepEqual(parseRuntimeEnvironment({...input,TRUST_PROXY:'10.20.0.5/32,fd00::5/128'}).trustedProxies,['10.20.0.5/32','fd00::5/128']);
 for(const value of ['true','1','2','0.0.0.0/0','::/0','invalid','10.2.0.5/99'])assert.throws(()=>parseRuntimeEnvironment({...input,TRUST_PROXY:value}));
});
