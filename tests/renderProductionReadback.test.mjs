import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditRenderProductionReadback} from '../scripts/checkRenderProductionReadback.mjs';

const good=()=>({
  id:'srv-darqr0l9fdbs73amtig0',
  repo:'https://github.com/Wamwod10/Zenix-Pos-Backend',
  branch:'main',autoDeploy:'no',type:'web_service',
  serviceDetails:{
    envSpecificDetails:{buildCommand:'npm ci',startCommand:'npm run start'},
    healthCheckPath:'/ready', suspended:'not_suspended',
  },
});

test('Render readback audit passes aligned, manual-only production service',()=>{
  const out=auditRenderProductionReadback(good());
  assert.equal(out.status,'SERVICE_CONFIGURATION_ALIGNED');
  assert.deepEqual(out.drifts,[]);
  assert.equal(out.serviceUpdated,false);
  assert.equal(out.workerOwnershipVerified,false);
  assert.equal(out.liveHealthVerified,false);
});

test('observed Nov 12 drift is detected without changing live service',()=>{
  const data=good();
  data.serviceDetails.healthCheckPath='';
  data.serviceDetails.envSpecificDetails.buildCommand='npm install';
  const out=auditRenderProductionReadback(data);
  assert.equal(out.status,'CONFIG_DRIFT');
  assert.deepEqual(out.drifts.map(row=>row.field),['buildCommand','healthCheckPath']);
  assert.equal(out.deploymentTriggered,false);
});

test('fails closed when Render service identity or readback shape differs',()=>{
  assert.throws(()=>auditRenderProductionReadback(null),/Invalid/);
  assert.throws(()=>auditRenderProductionReadback({}),/Unexpected/);
  assert.throws(()=>auditRenderProductionReadback({...good(),id:'srv-another'}),/Unexpected/);
  assert.throws(()=>auditRenderProductionReadback({...good(),repo:'https://github.com/other/repo'}),/Unexpected/);
  const noDetails=good();delete noDetails.serviceDetails;
  assert.throws(()=>auditRenderProductionReadback(noDetails),/Incomplete/);
});

test('manual deployment and ready probe regressions fail the readback',()=>{
  const data=good();
  data.autoDeploy='yes';
  data.branch='develop';
  data.serviceDetails.healthCheckPath='/health';
  const out=auditRenderProductionReadback({result:data});
  assert.deepEqual(out.drifts.map(row=>row.field),['branch','autoDeploy','healthCheckPath']);
});

test('tested Node major agrees with repo version preference for next rollout',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  const version=readFileSync(new URL('../.node-version',import.meta.url),'utf8').trim();
  assert.equal(version,'22');
  assert.equal(pkg.engines.node,'>=22 <23');
  assert.equal(lock.packages[''].engines.node,pkg.engines.node);
});
