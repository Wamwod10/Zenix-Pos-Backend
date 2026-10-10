// Only server environment controls this exception. Missing/expired config fails closed.
export function trialVerificationPolicy(source=process.env,now=new Date()){
 const configuredMode=source.TRIAL_PHONE_VERIFICATION_MODE||'required';
 if(!['required','temporary_disabled'].includes(configuredMode))throw new Error('Invalid TRIAL_PHONE_VERIFICATION_MODE');
 const raw=source.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL;
 if(configuredMode==='temporary_disabled'&&(!raw||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)||!Number.isFinite(Date.parse(raw))))throw new Error('Temporary trial verification requires a valid UTC TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL');
 if(configuredMode==='temporary_disabled'&&new Date(raw).toISOString().slice(0,19)!==raw.slice(0,19))throw new Error('Temporary trial cutoff is not a valid calendar date');
 const temporaryUntil=configuredMode==='temporary_disabled'?new Date(raw).toISOString():null;
 const disabled=configuredMode==='temporary_disabled'&&now.getTime()<Date.parse(temporaryUntil);
 return {configuredMode,mode:disabled?'temporary_disabled':'required',phoneVerificationRequired:!disabled,temporaryUntil,temporaryExpired:configuredMode==='temporary_disabled'&&!disabled,serverTime:now.toISOString()};
}
