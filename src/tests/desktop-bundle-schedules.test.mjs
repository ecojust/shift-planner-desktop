import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBundleScheduleFixtures, verifyScheduleFixtures } from '../../scripts/verify-desktop-bundle.mjs';
import { datesOfMonth, generateSchedule, validateSchedule } from '../scheduler.ts';

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

test('bundle fixtures distinguish minimum staffing from genuinely impossible monthly hours', () => {
  const { coverage, reference, weighted } = makeBundleScheduleFixtures();
  assert.equal(coverage.employees.length, 12);
  assert.ok(coverage.employees.every(employee => employee.minHoursPerMonth === 0 && employee.minHoursPerWeek === 0));
  assert.ok(reference.employees.every(employee => employee.minHoursPerMonth === 744 && employee.minHoursPerWeek === 0));
  assert.equal(weighted.employees.length, 2);
  assert.ok(weighted.employees.every(employee => employee.minHoursPerMonth === 120 && employee.minHoursPerWeek === 14));
  assert.deepEqual(weighted.rules.weekdayWeights, { days: [6, 7], percent: 40 });
  for (const state of [coverage, reference, weighted]) assert.deepEqual(state.assignments, []);
});

test('bundle verifier checks daily staffing minimums and actual weighted totals rather than fixed capacity', async () => {
  const checked = await verifyScheduleFixtures(runner(), 'regression');
  assert.ok(checked.result.assignments.length >= 155);
  for (const date of datesOfMonth(checked.state.month)) {
    for (const shift of checked.state.shifts) {
      assert.ok(checked.result.assignments.filter(item => item.date === date && item.shiftId === shift.id).length >= shift.required);
    }
  }
  assert.deepEqual(checked.independentRuleIssues, []);
  assert.equal(checked.constraintChecks.defaultReference.status, 'INFEASIBLE');
  assert.equal(checked.constraintChecks.defaultReference.fixtureKind, 'impossible-monthly-minimum');
  assert.equal(checked.constraintChecks.defaultReference.minimumHoursPerEmployee, 744);
  const weighted = checked.constraintChecks.positiveMinimumsAndWeights;
  assert.ok(weighted.assignmentCount >= 31);
  assert.equal(weighted.weeklyQuotas.length, 5);
  assert.equal(weighted.weeklyQuotas.reduce((sum, week) => sum + week.assignmentCount, 0), weighted.assignmentCount);
  for (const week of weighted.weeklyQuotas) {
    assert.ok(week.fullWeekCountCandidates.length > 0);
    assert.equal(week.totalTarget, week.assignmentCount);
    assert.equal(week.selectedTarget, week.selectedCount);
    // Complete weeks apply the configured percentage to the actual total.
    if (['2026-10-05', '2026-10-12', '2026-10-19'].includes(week.week)) {
      assert.equal(week.selectedCount, Math.ceil(week.assignmentCount * .4));
      assert.ok(week.fullWeekCountCandidates.includes(week.assignmentCount));
    }
  }
  assert.ok(Object.values(weighted.monthlyHours).every(hours => hours >= 120));
  assert.deepEqual(weighted.independentRuleIssues, []);
});

test('invalid or unknown default-reference responses never count as proven infeasibility', async () => {
  for (const status of ['MODEL_INVALID', 'UNKNOWN']) {
    await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
      if (request.requestId.endsWith('-reference')) result.status = status;
    }), 'regression'), /744-hour monthly minimum/);
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

test('bundle verifier accepts an otherwise valid assignment above a daily minimum', async () => {
  let added;
  const checked = await verifyScheduleFixtures(runner((request, result) => {
    if (!request.requestId.endsWith('-coverage')) return;
    for (const date of datesOfMonth(request.state.month)) {
      for (const shift of request.state.shifts) {
        for (const employee of request.state.employees) {
          const assignment = { employeeId: employee.id, date, shiftId: shift.id, locked: false };
          const assignments = [...result.assignments, assignment];
          if (!validateSchedule({ ...request.state, assignments }).length) {
            result.assignments = assignments;
            added = assignment;
            return;
          }
        }
      }
    }
    assert.fail('Coverage fixture should allow at least one additional valid shift');
  }), 'regression');
  assert.ok(added);
  const shift = checked.state.shifts.find(item => item.id === added.shiftId);
  assert.ok(checked.result.assignments.filter(item => item.date === added.date && item.shiftId === added.shiftId).length > shift.required);
  assert.deepEqual(checked.independentRuleIssues, []);
});

test('an adequate monthly total cannot hide a missing daily shift', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (!request.requestId.endsWith('-coverage')) return;
    const date = `${request.state.month}-01`, shiftId = request.state.shifts[0].id;
    result.assignments = result.assignments.map(item => item.date === date && item.shiftId === shiftId
      ? { ...item, date: `${request.state.month}-02` } : item);
  }), 'regression'), /daily minimum coverage is missing/);
});
