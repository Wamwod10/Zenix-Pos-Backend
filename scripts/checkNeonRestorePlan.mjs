// Preflight only: validates a human-supplied, current Neon readback and a
// proposed connector call. Does NOT call Neon, connect to PostgreSQL or restore.
// Baseline IDs intentionally pin the pre-incident Zenix production identity.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const ZENIX_PRODUCTION_BASELINE = Object.freeze({
  projectId: 'steep-wind-39440568',
  branchId: 'br-small-dew-b197rvkz',
  endpointId: 'ep-patient-field-b1xbogfo',
});

const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value, prefix) => typeof value === 'string' &&
  new RegExp('^' + prefix + '-[a-z0-9-]{5,60}$').test(value);

// This is a fail-closed *plan validator*, not a certificate that provider state
// was fetched live or that the restore will be safe at execution time.
export function validateNeonIsolatedRestorePlan(plan) {
  if (!record(plan)) fail('Missing preflight plan');
  const allowed = ['approval_reference', 'production_branch', 'production_endpoint',
    'project_id', 'restore_request', 'snapshot'];
  if (Object.keys(plan).some(key => !allowed.includes(key))) fail('Unexpected preflight field');
  if (plan.project_id !== ZENIX_PRODUCTION_BASELINE.projectId) fail('Unrecognized project');
  if (typeof plan.approval_reference !== 'string' ||
      plan.approval_reference.trim().length < 8) fail('Operator approval reference required');

  const branch = plan.production_branch;
  const endpoint = plan.production_endpoint;
  const snapshot = plan.snapshot;
  const request = plan.restore_request;
  if (![branch, endpoint, snapshot, request].every(record)) fail('Incomplete provider readback');

  if (branch.id !== ZENIX_PRODUCTION_BASELINE.branchId ||
      branch.project_id !== plan.project_id ||
      branch.name !== 'production' ||
      branch.default !== true || branch.protected !== true ||
      branch.current_state !== 'ready') fail('Production branch identity or protection changed');

  if (endpoint.id !== ZENIX_PRODUCTION_BASELINE.endpointId ||
      endpoint.branch_id !== branch.id ||
      endpoint.type !== 'read_write' ||
      endpoint.current_state !== 'active') fail('Production endpoint mapping changed');

  if (!isId(snapshot.id, 'snap') ||
      snapshot.source_branch_id !== branch.id) fail('Snapshot is not from the expected production branch');

  // The Neon connector's restore_snapshot tool defaults finalize to TRUE
  // for a newly created branch. An omitted value is a production hazard.
  const allowedRestoreKeys = ['project_id', 'snapshot_id', 'name', 'finalize'];
  if (Object.keys(request).some(key => !allowedRestoreKeys.includes(key)))
    fail('Unsafe or unsupported restore request field');
  if (!Object.hasOwn(request, 'finalize') || request.finalize !== false)
    fail('Explicit connector finalize:false is mandatory');
  if (request.project_id !== plan.project_id || request.snapshot_id !== snapshot.id)
    fail('Restore request does not match approved source snapshot');
  if (typeof request.name !== 'string' ||
      !/^zenix-rehearsal-[a-z0-9-]{8,60}$/.test(request.name) ||
      /production|live|main/i.test(request.name))
    fail('New isolated rehearsal branch name required');

  return Object.freeze({
    status: 'STATIC_PLAN_VALIDATED',
    writesPerformed: false,
    providerReadbackAuthenticated: false,
    providerRestoreVerified: false,
    productionEndpointVerifiedAfterRestore: false,
    productionBranchId: branch.id,
    productionEndpointId: endpoint.id,
    snapshotId: snapshot.id,
    rehearsalBranchName: request.name,
    nextStep: 'Human must recheck live identities, change approval, quota, and execute separately with finalize:false',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail('Provide one local JSON preflight path');
    const input = readFileSync(process.argv[2], 'utf8');
    if (input.length > 32_768) fail('Preflight payload too large');
    const result = validateNeonIsolatedRestorePlan(JSON.parse(input));
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Never echo file input, provider IDs from an untrusted plan, or secrets.
    console.error('NEON_RESTORE_PREFLIGHT_BLOCKED');
    process.exitCode = 1;
  }
}
