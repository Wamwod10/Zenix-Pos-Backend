import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectAssetType, isAssetContentValid } from '../src/lib/uploadType.js';

const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(12)]);
const jpg=Buffer.from([255,216,255,224,0,0,0,0,255,217]);
const pdf=Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n');
function webp(){
  // RIFF length = complete file length minus eight bytes.
  const bytes=Buffer.alloc(20);
  bytes.write('RIFF',0,'ascii');bytes.writeUInt32LE(12,4);
  bytes.write('WEBP',8,'ascii');bytes.write('VP8 ',12,'ascii');
  return bytes;
}

test('assets accept only binary signatures matching the claimed MIME',()=>{
  for(const [bytes,type] of [[png,'image/png'],[jpg,'image/jpeg'],[pdf,'application/pdf'],[webp(),'image/webp']]){
    assert.equal(detectAssetType(bytes),type);
    assert.equal(isAssetContentValid(bytes,type),true);
  }
});
test('assets reject spoofed MIME, script, and truncated RIFF files',()=>{
  assert.equal(isAssetContentValid(pdf,'image/png'),false);
  assert.equal(isAssetContentValid(Buffer.from('<script>alert(1)</script>'),'image/png'),false);
  const truncated=webp();truncated.writeUInt32LE(100_000,4);
  assert.equal(isAssetContentValid(truncated,'image/webp'),false);
  assert.equal(detectAssetType(Buffer.from('RIFF')),null);
  const invalidChunk=webp();invalidChunk.write('HTML',12,'ascii');
  assert.equal(detectAssetType(invalidChunk),null);
});
test('asset upload route rejects mismatched signatures before database insertion',()=>{
  const source=readFileSync(new URL('../src/routes/files.js',import.meta.url),'utf8');
  assert.match(source,/isAssetContentValid\(content,mimeType\)/);
  assert.ok(source.indexOf('isAssetContentValid(content,mimeType)')<source.indexOf('INSERT INTO file_assets'));
});
