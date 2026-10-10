import test from 'node:test';
import assert from 'node:assert/strict';
import {trialVerificationPolicy} from '../src/services/trialVerificationPolicy.js';

test('temporary mode is explicit, bounded by server time, and expires to required',()=>{
 const now=new Date('2026-10-10T00:00:00Z');
 assert.equal(trialVerificationPolicy({},now).phoneVerificationRequired,true);
 const config={TRIAL_PHONE_VERIFICATION_MODE:'temporary_disabled',TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL:'2026-10-11T00:00:00Z'};
 assert.equal(trialVerificationPolicy(config,now).phoneVerificationRequired,false);
 assert.equal(trialVerificationPolicy(config,new Date(config.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL)).phoneVerificationRequired,true);
 assert.equal(trialVerificationPolicy({...config,TRIAL_PHONE_VERIFICATION_MODE:'required'},now).phoneVerificationRequired,true);
 for(const config of [{TRIAL_PHONE_VERIFICATION_MODE:'disabled'},{TRIAL_PHONE_VERIFICATION_MODE:'temporary_disabled'},{TRIAL_PHONE_VERIFICATION_MODE:'temporary_disabled',TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL:'invalid'}])assert.throws(()=>trialVerificationPolicy(config,now));
 assert.throws(()=>trialVerificationPolicy({...config,TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL:'2026-02-31T00:00:00Z'},now));
});
