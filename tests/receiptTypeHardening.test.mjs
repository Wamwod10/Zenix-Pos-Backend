import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReceiptType, isReceiptConsistent } from '../src/lib/receiptType.js';

const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(12)]);
const jpg=Buffer.from([255,216,255,224,0,0,0,0,255,217]);
const pdf=Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n');

test('receipt sniffer accepts matching actual PNG, JPEG and PDF files',()=>{
  for(const [bytes,mime] of [[png,'image/png'],[jpg,'image/jpeg'],[pdf,'application/pdf']]){
    assert.equal(detectReceiptType(bytes),mime);
    assert.equal(isReceiptConsistent(bytes,mime),true);
  }
});
test('receipt sniffer rejects MIME confusion, empty payload and executable text',()=>{
  assert.equal(isReceiptConsistent(pdf,'image/png'),false);
  assert.equal(isReceiptConsistent(Buffer.from('<script>alert(1)</script>'),'image/jpeg'),false);
  assert.equal(isReceiptConsistent(Buffer.alloc(0),'image/png'),false);
  assert.equal(isReceiptConsistent(Buffer.from('%PDF-1.5\ntruncated'),'application/pdf'),false);
});
