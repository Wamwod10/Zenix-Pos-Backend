import {HttpError} from '../lib/http.js';
// Prevent new activation until frontend and backend have passed the release gate.
// Disabling, configuring disabled policies and existing enabled tenants are not blocked.
export function assertCommerceOfferActivation(previous,next,available=process.env.ZENIX_COMMERCE_OFFERS_ENABLED==='true'){
 if(previous?.enabled!==true&&next?.enabled===true&&!available)throw new HttpError(409,'Bonus to‘lovi va aksiyalar hali faollashtirilmagan','COMMERCE_OFFERS_NOT_AVAILABLE');
}
