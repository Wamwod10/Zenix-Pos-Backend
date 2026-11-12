import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZENIX_PRODUCTION_BASELINE,
  validateNeonIsolatedRestorePlan,
} from '../scripts/checkNeonRestorePlan.mjs';

const validPlan = () => ({
  project_id: ZENIX_PRODUCTION_BASELINE.projectId,
  approval_reference: 'OPS-97-approved-rehearsal',
  production_branch: {
    id: ZENIX_PRODUCTION_BASELINE.branchId,
    project_id: ZENIX_PRODUCTION_BASELINE.projectId,
    name: 'production', default: true, protected: true, current_state: 'ready',
  },
  production_endpoint: {
    id: ZENIX_PRODUCTION_BASELINE.endpointId,
    branch_id: ZENIX_PRODUCTION_BASELINE.branchId,
    type: 'read_write', current_state: 'active',
  },
  snapshot: {
    id: 'snap-sparkling-breeze-b1sz42w7',
    source_branch_id: ZENIX_PRODUCTION_BASELINE.branchId,
  },
  restore_request: {
    project_id: ZENIX_PRODUCTION_BASELINE.projectId,
    snapshot_id: 'snap-sparkling-breeze-b1sz42w7',
    name: 'zenix-rehearsal-nonprod-20261112',
    finalize: false,
  },
});
const rejects = (edit, hint) => {
  const plan = validPlan();
  edit(plan);
  assert.throws(() => validateNeonIsolatedRestorePlan(plan), hint);
};

test('safe offline candidate requires scoped production identities and explicit non-finalize', () => {
  const result = validateNeonIsolatedRestorePlan(validPlan());
  assert.equal(result.status, 'STATIC_PLAN_VALIDATED');
  assert.equal(result.writesPerformed, false);
  assert.equal(result.providerRestoreVerified, false);
  assert.equal(result.providerReadbackAuthenticated, false);
  assert.equal(result.productionEndpointVerifiedAfterRestore, false);
  assert.equal(result.productionBranchId, ZENIX_PRODUCTION_BASELINE.branchId);
  assert.equal(result.productionEndpointId, ZENIX_PRODUCTION_BASELINE.endpointId);
});

test('Neon connector default finalize=true is rejected when omitted or true', () => {
  rejects(plan => { delete plan.restore_request.finalize; }, /finalize:false/);
  rejects(plan => { plan.restore_request.finalize = true; }, /finalize:false/);
  rejects(plan => { plan.restore_request.finalize = 'false'; }, /finalize:false/);
  rejects(plan => {
    delete plan.restore_request.finalize;
    plan.restore_request.finalize_restore = false;
  }, /unsupported restore request/);
});

test('target branch, unknown commands, or production-looking names are forbidden', () => {
  rejects(plan => { plan.restore_request.target_branch_id = ZENIX_PRODUCTION_BASELINE.branchId; }, /Unsafe/);
  rejects(plan => { plan.restore_request.delete_existing = true; }, /Unsafe/);
  rejects(plan => { plan.restore_request.name = 'production'; }, /isolated/);
  rejects(plan => { plan.restore_request.name = 'zenix-rehearsal-production-copy'; }, /isolated/);
  rejects(plan => { plan.restore_request.name = ''; }, /isolated/);
});

test('fail closed when production branch or compute endpoint identity changes', () => {
  rejects(plan => { plan.project_id = 'steep-wind-unknown'; }, /project/);
  rejects(plan => { plan.production_branch.id = 'br-wrong-b1234567'; }, /identity/);
  rejects(plan => { plan.production_branch.default = false; }, /identity/);
  rejects(plan => { plan.production_branch.protected = false; }, /identity/);
  rejects(plan => { plan.production_branch.current_state = 'archived'; }, /identity/);
  rejects(plan => { plan.production_endpoint.id = 'ep-wrong-b1234567'; }, /endpoint/);
  rejects(plan => { plan.production_endpoint.branch_id = 'br-wrong-b1234567'; }, /endpoint/);
  rejects(plan => { plan.production_endpoint.current_state = 'idle'; }, /endpoint/);
});

test('restore proposal must use a matching production snapshot and approved project', () => {
  rejects(plan => { plan.snapshot.source_branch_id = 'br-other-b1234567'; }, /Snapshot/);
  rejects(plan => { plan.snapshot.id = 'not-a-snapshot'; }, /Snapshot/);
  rejects(plan => { plan.restore_request.snapshot_id = 'snap-other-b1234567'; }, /approved/);
  rejects(plan => { plan.restore_request.project_id = 'another-project'; }, /approved/);
  rejects(plan => { plan.approval_reference = ''; }, /approval/);
  rejects(plan => { plan.fake_token = 'should-never-appear-in-results'; }, /Unexpected preflight field/);
});

test('malformed or incomplete plans never receive a positive preflight result', () => {
  assert.throws(() => validateNeonIsolatedRestorePlan(null), /Missing/);
  rejects(plan => { plan.production_endpoint = undefined; }, /Incomplete/);
  rejects(plan => { plan.restore_request = []; }, /Incomplete/);
});
