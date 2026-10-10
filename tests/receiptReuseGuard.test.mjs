import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertReceiptAvailable } from '../src/services/receiptReuseGuard.js';

const ORG='11111111-1111-4111-8111-111111111111';
const RECEIPT='22222222-2222-4222-8222-222222222222';

test('a fresh receipt can be submitted and lookup stays within organization scope', async () => {
  const calls=[];
  await assertReceiptAvailable({query:async (...args)=>{calls.push(args);return {rows:[]};}},
    {organizationId:ORG,receiptId:RECEIPT});
  assert.match(calls[0][0], /proposed_receipt\.id=\$2 AND proposed_receipt\.organization_id=\$1/);
  assert.match(calls[0][0], /prior_receipt\.content=proposed_receipt\.content/);
  assert.deepEqual(calls[0][1],[ORG,RECEIPT]);
});

test('a previously submitted receipt is rejected even after payment review', async () => {
  for (const status of ['REVIEW','APPROVED','REJECTED']) {
    await assert.rejects(
      assertReceiptAvailable({query:async()=>({rows:[{id:'payment',status}]})},
        {organizationId:ORG,receiptId:RECEIPT}),
      error=>error.status===409 && error.code==='BILLING_RECEIPT_ALREADY_USED',
    );
  }
});

test('payment submission locks the selected receipt before reuse check and insertion', () => {
  const source=readFileSync(new URL('../src/routes/billing.js',import.meta.url),'utf8');
  const receiptLock=source.indexOf('FROM billing_receipts WHERE id=$1 AND organization_id=$2 FOR UPDATE');
  const reuseCheck=source.indexOf('await assertReceiptAvailable(client');
  const insert=source.indexOf('INSERT INTO billing_payments(',receiptLock);
  assert.ok(receiptLock>=0 && receiptLock<reuseCheck && reuseCheck<insert);
  assert.match(source,/SELECT id FROM organizations WHERE id=\$1 FOR UPDATE/);
});

// The receipt guard intentionally compares bytes, not just the upload ID.
// A second upload of the same bank transfer must not buy another subscription.
test('re-uploaded identical receipt evidence is checked, even under a new id', () => {
  const source=readFileSync(new URL('../src/services/receiptReuseGuard.js',import.meta.url),'utf8');
  assert.match(source, /JOIN billing_receipts prior_receipt/);
  assert.match(source, /prior_receipt\.content=proposed_receipt\.content/);
  assert.match(source, /payment\.organization_id=\$1/);
});
