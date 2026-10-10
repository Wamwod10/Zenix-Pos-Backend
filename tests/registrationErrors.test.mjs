import test from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../src/middleware/error.js';

test('username collisions have an actionable code and do not expose SQL details', () => {
  for (const constraint of ['users_username_global_unique', 'users_org_username_unique']) {
    const response = {status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
    errorHandler({code:'23505',constraint,detail:'private SQL data'}, {}, response, ()=>{});
    assert.equal(response.statusCode,409);
    assert.equal(response.body.error.code,'USERNAME_EXISTS');
    assert.doesNotMatch(JSON.stringify(response.body), /private SQL data/);
  }
});
