import test from 'node:test';
import assert from 'node:assert/strict';
import {validThermalLogo,redactSettingsAuditLogo} from '../src/lib/thermalLogo.js';
import {validateWorkspaceValues} from '../src/lib/settingsRevision.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('thermal logo accepts a bounded PNG, removal, and rejects unsafe formats and dimensions',()=>{
 assert.equal(validThermalLogo(png),true);
 assert.equal(validThermalLogo(''),true);
 for(const value of ['https://example.com/logo.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,AAAA',png+'" onerror="x',png+'A',null])assert.equal(validThermalLogo(value),false);
 const huge=Buffer.from(png.slice(22),'base64');huge.writeUInt32BE(20000,16);
 assert.equal(validThermalLogo('data:image/png;base64,'+huge.toString('base64')),false);
 assert.throws(()=>validateWorkspaceValues({storeOverrides:{a:{receipt:{logoData:'https://example.com'}}}}),e=>e.status===400);
 assert.doesNotThrow(()=>validateWorkspaceValues({receipt:{logoData:png}}));
});
test('audit replaces logo bytes with fingerprints without changing live settings',()=>{
 const original={workspaceSettings:{receipt:{logoData:png,width:'80'},storeOverrides:{a:{receipt:{logoData:png}}}}};
 const redacted=redactSettingsAuditLogo(original);
 assert.match(redacted.workspaceSettings.receipt.logoData,/^sha256:[a-f0-9]{64}$/);
 assert.equal(redacted.workspaceSettings.storeOverrides.a.receipt.logoData,redacted.workspaceSettings.receipt.logoData);
 assert.equal(original.workspaceSettings.receipt.logoData,png);
 assert.equal(redacted.workspaceSettings.receipt.width,'80');
});
