import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundleScheduleFixtures, verifyScheduleFixtures } from '../../scripts/verify-desktop-bundle.mjs';
import { generateSchedule } from '../scheduler.ts';

// Controlled responses exercise the verifier's acceptance rules without adding
// a Python installation requirement to the frontend test suite. Native CI calls
// the same verifier with captureFrozen and the actual installed OR-Tools binary.
function response(request) {
  const common = { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', stats: { shortageCount: 0 } };
  if (request.requestId.endsWith('-reference')) return { ...common, status: 'INFEASIBLE', issues: [{ type: 'monthly-min-hours' }] };
  const schedule = generateSchedule(request.state, 1010);
  assert.equal(schedule.success, true);
  return { ...common, status: 'FEASIBLE', assignments: schedule.assignments };
}
function runner(change = () => {}) {
  return async request => {
    const result = response(request);
    change(request, result);
    return { stdout: JSON.stringify(result), elapsedSeconds: 0, stages: [] };
  };
}

test('bundle fixtures resolve references and distinguish coverage from positive minimums', () => {
  const { coverage, reference, weighted } = makeBundleScheduleFixtures();
  assert.equal(coverage.employees.length, 12);
  assert.ok(coverage.employees.every(employee => employee.minHoursPerMonth === 0 && employee.minHoursPerWeek === 0));
  assert.ok(reference.employees.every(employee => employee.minHoursPerMonth === 144 && employee.minHoursPerWeek === 0));
  assert.equal(weighted.employees.length, 2);
  assert.ok(weighted.employees.every(employee => employee.minHoursPerMonth === 120 && employee.minHoursPerWeek === 14));
  assert.deepEqual(weighted.rules.weekdayWeights, { days: [6, 7], percent: 40 });
  for (const state of [coverage, reference, weighted]) assert.deepEqual(state.assignments, []);
});

test('bundle verifier retains the 155-seat report and checks minimums, partial weeks and weighted quotas', async () => {
  const checked = await verifyScheduleFixtures(runner(), 'regression');
  assert.equal(checked.result.assignments.length, 155);
  assert.deepEqual(checked.independentRuleIssues, []);
  assert.equal(checked.constraintChecks.defaultReference.status, 'INFEASIBLE');
  const weighted = checked.constraintChecks.positiveMinimumsAndWeights;
  assert.equal(weighted.assignmentCount, 32);
  assert.deepEqual(weighted.weeklyQuotas.map(week => [week.assignmentCount, week.selectedCount]), [[5, 3], [7, 3], [7, 3], [7, 3], [6, 2]]);
  assert.ok(Object.values(weighted.monthlyHours).every(hours => hours >= 120));
  assert.deepEqual(weighted.independentRuleIssues, []);
});

test('invalid or unknown default-reference responses never count as proven infeasibility', async () => {
  for (const status of ['MODEL_INVALID', 'UNKNOWN']) {
    await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
      if (request.requestId.endsWith('-reference')) result.status = status;
    }), 'regression'), /Default reference minimums/);
  }
});

test('infeasible reference models cannot return a replacement roster', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (request.requestId.endsWith('-reference')) result.assignments = [];
  }), 'regression'), /must not supply a replacement roster/);
});

test('a claimed weighted success is rejected when returned assignments violate employee rules', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (request.requestId.endsWith('-weighted')) {
      result.assignments = result.assignments.map(item => ({ ...item, employeeId: request.state.employees[0].id }));
    }
  }), 'regression'), /Actual app schedule must pass independent TypeScript rules/);
});
