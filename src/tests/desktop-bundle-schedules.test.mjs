import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLE_REFERENCE_DATE, makeBundleScheduleFixtures, verifyScheduleFixtures } from '../../scripts/verify-desktop-bundle.mjs';
import { datesOfMonth, generateSchedule, validateBoundaryPreview } from '../scheduler.ts';

// Controlled responses exercise the verifier's acceptance rules without adding
// a Python installation requirement to the frontend test suite. Native CI calls
// the same verifier with captureFrozen and the actual installed OR-Tools binary.
function response(request) {
  const common = { protocolVersion: 1, requestId: request.requestId, engine: 'ortools-cp-sat', stats: { shortageCount: 0 } };
  if (request.requestId.endsWith('-reference')) return { ...common, status: 'INFEASIBLE', issues: [{ type: 'weekly-fixed-capacity' }] };
  assert.equal(request.options.referenceDate, BUNDLE_REFERENCE_DATE);
  const schedule = generateSchedule(request.state, 1010, undefined, { referenceDate: request.options.referenceDate });
  assert.equal(schedule.success, true);
  return { ...common, status: 'FEASIBLE', assignments: schedule.assignments, boundaryPreview: schedule.boundaryPreview, boundaryContext: schedule.boundaryContext };
}
function runner(change = () => {}) {
  return async request => {
    const result = response(request);
    change(request, result);
    return { stdout: JSON.stringify(result), elapsedSeconds: 0, stages: [] };
  };
}

test('bundle fixtures distinguish minimum staffing from genuinely impossible weekly fixed capacity', () => {
  const { coverage, reference, weighted } = makeBundleScheduleFixtures();
  assert.equal(coverage.employees.length, 12);
  assert.ok(coverage.employees.every(employee => employee.minHoursPerWeek === 0));
  assert.ok(reference.employees.every(employee => employee.minHoursPerWeek === 40 && employee.maxHoursPerWeek === 48));
  assert.ok(reference.shifts.every(shift => shift.staffingMode === 'fixed'));
  assert.equal(reference.shifts.reduce((sum, shift) => sum + shift.required * 8 * 7, 0), 280);
  assert.equal(reference.employees.reduce((sum, employee) => sum + employee.minHoursPerWeek, 0), 480);
  assert.equal(weighted.employees.length, 2);
  assert.ok(weighted.employees.every(employee => employee.minHoursPerWeek === 14));
  assert.deepEqual(weighted.rules.weekdayWeights, { days: [6, 7], percent: 40 });
  for (const state of [coverage, reference]) assert.deepEqual(state.assignments, []);
  assert.deepEqual(coverage.scheduleCoverage['2026-09'].employeeIds, coverage.employees.map(employee => employee.id));
  assert.equal(weighted.assignments.length, 5);
  assert.equal(weighted.assignments.filter(item => item.date === '2026-11-01').length, 2);
  for (const month of ['2026-09', '2026-11']) assert.deepEqual(weighted.scheduleCoverage[month].employeeIds, weighted.employees.map(employee => employee.id));
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
  assert.equal(checked.constraintChecks.futureBoundary.referenceDate, BUNDLE_REFERENCE_DATE);
  assert.ok(checked.constraintChecks.futureBoundary.provisionalAssignmentCount >= 5);
  assert.equal(checked.constraintChecks.futureBoundary.persistedOutsideAssignmentCount, 0);
  assert.equal(checked.constraintChecks.defaultReference.status, 'INFEASIBLE');
  assert.equal(checked.constraintChecks.defaultReference.fixtureKind, 'impossible-weekly-fixed-capacity');
  assert.equal(checked.constraintChecks.defaultReference.minimumWeeklyHoursPerEmployee, 40);
  assert.equal(checked.constraintChecks.defaultReference.totalMinimumWeeklyHours, 480);
  assert.equal(checked.constraintChecks.defaultReference.fixedWeeklyCapacityHours, 280);
  const weighted = checked.constraintChecks.positiveMinimumsAndWeights;
  assert.ok(weighted.assignmentCount >= 31);
  assert.equal(weighted.weeklyQuotas.length, 5);
  assert.equal(weighted.weeklyQuotas.reduce((sum, week) => sum + week.assignmentCount, 0), weighted.assignmentCount);
  for (const week of weighted.weeklyQuotas) {
    assert.ok(week.fullWeekCountCandidates.length > 0);
    assert.equal(week.totalTarget, week.assignmentCount);
    assert.equal(week.selectedTarget, week.selectedCount);
    // Every touching week, including both month boundaries, is complete.
    assert.equal(week.selectedCount, Math.ceil(week.assignmentCount * .4));
    assert.deepEqual(week.fullWeekCountCandidates, [week.assignmentCount]);
  }
  assert.equal(weighted.weeklyHours.length, 10);
  assert.ok(weighted.weeklyHours.every(week => week.minutes >= week.minimumMinutes && week.minutes <= week.maximumMinutes));
  assert.deepEqual(weighted.independentRuleIssues, []);
});

test('invalid or unknown default-reference responses never count as proven infeasibility', async () => {
  for (const status of ['MODEL_INVALID', 'UNKNOWN']) {
    await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
      if (request.requestId.endsWith('-reference')) result.status = status;
    }), 'regression'), /480-hour weekly minimum/);
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
      result.assignments = result.assignments.map(item => item.date.startsWith(`${request.state.month}-`) ? { ...item, employeeId: request.state.employees[0].id } : item);
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
          if (!validateBoundaryPreview({ ...request.state, assignments }, result.boundaryPreview, request.options.referenceDate).length) {
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

test('future provisional coverage must be present and independently valid', async () => {
  for (const change of [result => { delete result.boundaryPreview; }, result => { result.boundaryPreview = []; }]) {
    await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
      if (request.requestId.endsWith('-coverage')) change(result);
    }), 'regression'), /boundary preview|independent TypeScript rules/);
  }
});

test('provisional neighboring assignments cannot be published in the saved result', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (request.requestId.endsWith('-coverage')) result.assignments.push(result.boundaryPreview[0]);
  }), 'regression'), /must never be published/);
});

test('confirmed next-month work remains immutable during complete-week validation', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (request.requestId.endsWith('-weighted')) result.assignments = result.assignments.filter(item => item.date !== '2026-11-01');
  }), 'regression'), /must never be published/);
});

test('an adequate monthly total cannot hide a missing daily shift', async () => {
  await assert.rejects(verifyScheduleFixtures(runner((request, result) => {
    if (!request.requestId.endsWith('-coverage')) return;
    const date = `${request.state.month}-01`, shiftId = request.state.shifts[0].id;
    result.assignments = result.assignments.map(item => item.date === date && item.shiftId === shiftId
      ? { ...item, date: `${request.state.month}-02` } : item);
  }), 'regression'), /daily minimum coverage is missing/);
});
