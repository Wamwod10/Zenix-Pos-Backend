// Offline, read-only inspection of a Render get_service JSON response.
// No Render API client, credential access, service updates, deployment or DB access.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const EXPECTED = Object.freeze({
  id:'srv-darqr0l9fdbs73amtig0',
  repo:'https://github.com/Wamwod10/Zenix-Pos-Backend',
  branch:'main',
  buildCommand:'npm ci',
  startCommand:'npm run start',
  healthCheckPath:'/ready',
});
const text = value => typeof value === 'string' ? value.trim() : '';
export function auditRenderProductionReadback(input){
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid Render get_service readback');
  const service=input.result && typeof input.result === 'object' ? input.result : input;
  if(service.id!==EXPECTED.id || text(service.repo).replace(/\.git$/,'')!==EXPECTED.repo)
    throw new Error('Unexpected Render service identity; refusing inspection');
  const actual=service.serviceDetails;
  if(!actual || typeof actual!=='object' || !actual.envSpecificDetails)
    throw new Error('Incomplete Render service readback');
  const drifts=[];
  const check=(field,expected,value)=>{
    if(value!==expected)drifts.push({field,expected,actual:value===undefined?'NOT_CONFIGURED':value});
  };
  check('branch',EXPECTED.branch,service.branch);
  check('autoDeploy','no',service.autoDeploy);
  check('serviceType','web_service',service.type);
  check('buildCommand',EXPECTED.buildCommand,text(actual.envSpecificDetails.buildCommand));
  check('startCommand',EXPECTED.startCommand,text(actual.envSpecificDetails.startCommand));
  check('healthCheckPath',EXPECTED.healthCheckPath,text(actual.healthCheckPath));
  if(actual.suspended && actual.suspended!=='not_suspended')
    drifts.push({field:'suspended',expected:'not_suspended',actual:actual.suspended});
  return {
    status:drifts.length?'CONFIG_DRIFT':'SERVICE_CONFIGURATION_ALIGNED',
    serviceId:EXPECTED.id, deploymentTriggered:false, serviceUpdated:false,
    liveHealthVerified:false, workerOwnershipVerified:false,
    drifts,
    cautions:[
      'Readback cannot attest HTTP /ready response or Render environment variable values.',
      'This check does not prove a separate notification worker exists or embedded workers are enabled.',
      'Changing health checks or runtime requires separate operator release review.',
    ],
  };
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    if(process.argv.length!==3)throw Error('Expected a local service JSON file');
    const raw=readFileSync(process.argv[2],'utf8');
    if(raw.length>64_000)throw Error('Readback exceeds size limit');
    const result=auditRenderProductionReadback(JSON.parse(raw));
    console.log(JSON.stringify(result,null,2));
    if(result.drifts.length)process.exitCode=1;
  }catch{
    console.error('RENDER_PRODUCTION_READBACK_REJECTED');
    process.exitCode=1;
  }
}
