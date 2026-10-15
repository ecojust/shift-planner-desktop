"""Selected-shift rules: actual solver results checked against calendar starts."""
import calendar
import copy
import datetime as dt
from collections import Counter
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve
from ortools.sat.python import cp_model


def employee(name, shifts=('early',), weekly_minimum=0):
    return dict(id=name, name=name, eligibleShiftIds=list(shifts), unavailableDates=[],
                minHoursPerWeek=weekly_minimum, maxHoursPerWeek=168)


def shift(sid='early', required=0, start='08:00', end='16:00'):
    return dict(id=sid, name=sid, start=start, end=end, required=required, staffingMode='minimum')


def assignment(date, sid='early', eid='a', locked=True):
    return dict(employeeId=eid, date=date, shiftId=sid, locked=locked)


def request(month='2026-10', employees=None, shifts=None, assignments=None, adjacency=(), weekly=(), partial=False):
    return dict(protocolVersion=1, requestId='shift-rule-test',
                state=dict(version=1, month=month, teamName='规则测试',
                           employees=employees or [employee('a')], shifts=shifts or [shift()],
                           assignments=assignments or [],
                           rules=dict(minRestHours=0, maxConsecutiveDays=31,
                                      nonConsecutiveShifts=[dict(id=f'adj-{sid}', shiftId=sid) for sid in adjacency],
                                      weeklyShiftLimits=[dict(id=f'week-{sid}', shiftId=sid, maxPerWeek=cap) for sid, cap in weekly])),
                options=dict(timeLimitSeconds=3, seed=1010, allowPartial=partial, referenceDate='2030-01-01'))


class ShiftRulesTest(unittest.TestCase):
    def assertFeasible(self, result):
        self.assertIn(result['status'], ('OPTIMAL', 'FEASIBLE'), result)
        self.assertIn('assignments', result)

    def assertConflict(self, result, kind):
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        matching = [item for item in result['issues'] if item['type'] == kind]
        self.assertTrue(matching, result)
        for item in matching:
            self.assertEqual(item['target'], 'rules')
            self.assertTrue(item.get('suggestion'))
            self.assertTrue(item.get('date'))
            self.assertTrue(item.get('employeeId'))
            self.assertTrue(item.get('shiftId'))

    def assertCalendarRules(self, data, result):
        """Independent date-only oracle; no solver time-split helper is reused."""
        month = data['state']['month']
        first = dt.date.fromisoformat(month + '-01')
        active = {first + dt.timedelta(days=offset) for offset in range(calendar.monthrange(first.year, first.month)[1])}
        active_weeks = {day - dt.timedelta(days=day.weekday()) for day in active}
        active = {week + dt.timedelta(days=offset) for week in active_weeks for offset in range(7)}
        starts = {}
        counts = Counter()
        for record in result['assignments'] + result.get('boundaryPreview', []):
            if record['shiftId'] == 'off':
                continue
            day = dt.date.fromisoformat(record['date'])
            starts.setdefault((record['employeeId'], record['shiftId']), set()).add(day)
            counts[(record['employeeId'], record['shiftId'], day - dt.timedelta(days=day.weekday()))] += 1
        for emp in data['state']['employees']:
            for rule in data['state']['rules']['nonConsecutiveShifts']:
                days = starts.get((emp['id'], rule['shiftId']), set())
                for day in days:
                    tomorrow = day + dt.timedelta(days=1)
                    if day in active or tomorrow in active:
                        self.assertNotIn(tomorrow, days)
            for rule in data['state']['rules']['weeklyShiftLimits']:
                for week in active_weeks:
                    self.assertLessEqual(counts[(emp['id'], rule['shiftId'], week)], rule['maxPerWeek'])

    def test_missing_lists_remain_backward_compatible(self):
        data = request()
        del data['state']['rules']['nonConsecutiveShifts']
        del data['state']['rules']['weeklyShiftLimits']
        self.assertFeasible(solve(data))

    def test_invalid_rule_schemas(self):
        for key in ('nonConsecutiveShifts', 'weeklyShiftLimits'):
            valid = dict(id='rule', shiftId='early')
            if key == 'weeklyShiftLimits':
                valid['maxPerWeek'] = 2
            bad_values = [None, {}, 'early', [None], [True], [dict(valid, id='')],
                          [dict(valid, id='x' * 65)], [dict(valid, id='with space')],
                          [dict(valid, id='中文')], [dict(valid, id='bad\n')],
                          [dict(valid, id=True)], [dict(valid, shiftId='missing')],
                          [dict(valid, shiftId=None)], [dict(valid, shiftId=['early'])],
                          [valid, dict(valid, id='second')],
                          [valid, dict(valid, shiftId='night')], [valid] * 25]
            if key == 'weeklyShiftLimits':
                bad_values += [[dict(valid, maxPerWeek=value)] for value in (-1, 8, 1.5, True, False, None, '2')]
                bad_values.append([dict(id='rule', shiftId='early')])
            for value in bad_values:
                with self.subTest(key=key, value=value):
                    data = request(shifts=[shift(), shift('night')])
                    data['state']['rules'][key] = value
                    result = solve(data)
                    self.assertEqual(result['status'], 'MODEL_INVALID', result)
                    self.assertNotIn('assignments', result)

    def test_same_id_and_shift_allowed_across_the_two_distinct_lists(self):
        data = request(adjacency=['early'], weekly=[('early', 2)])
        data['state']['rules']['nonConsecutiveShifts'][0]['id'] = 'shared_id-1'
        data['state']['rules']['weeklyShiftLimits'][0]['id'] = 'shared_id-1'
        self.assertFeasible(solve(data))

    def test_weekly_minimum_composes_with_adjacency_and_shift_count_limit(self):
        data = request(employees=[employee('a', weekly_minimum=16)],
                       adjacency=['early'], weekly=[('early', 2)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)
        counts = Counter()
        for record in result['assignments']:
            date = dt.date.fromisoformat(record['date'])
            counts[date - dt.timedelta(days=date.weekday())] += 1
        # All five natural weeks need two whole eight-hour shifts, including
        # October's four- and six-day fragments; zero coverage cannot force them.
        self.assertEqual(len(counts), 5)
        self.assertEqual(set(counts.values()), {2})
        data['state']['rules']['weeklyShiftLimits'][0]['maxPerWeek'] = 1
        result = solve(data)
        self.assertConflict(result, 'weekly-shift-limit')
        self.assertTrue(any(item['type'] == 'weekly-min-hours' for item in result['issues']), result)

    def test_fixed_adjacent_dates_have_actionable_proof(self):
        data = request(assignments=[assignment('2026-10-03'), assignment('2026-10-04')], adjacency=['early'])
        before = copy.deepcopy(data)
        result = solve(data)
        self.assertConflict(result, 'consecutive-shift')
        self.assertIn('2026-10-03', result['issues'][0]['message'])
        self.assertIn('2026-10-04', result['issues'][0]['message'])
        self.assertEqual(data, before)

    def test_non_adjacent_dates_and_different_shifts_are_allowed(self):
        data = request(employees=[employee('a', ['early', 'night'])], shifts=[shift(), shift('night', start='18:00', end='22:00')],
                       assignments=[assignment('2026-10-03'), assignment('2026-10-04', 'night'), assignment('2026-10-05')], adjacency=['early'])
        self.assertFeasible(solve(data))

    def test_fixed_off_breaks_adjacency(self):
        records = [assignment('2026-10-03'), assignment('2026-10-04', 'off'), assignment('2026-10-05')]
        data = request(assignments=records, adjacency=['early'], weekly=[('early', 2)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertTrue(all(record in result['assignments'] for record in records))

    def test_unlocked_current_assignments_are_replaceable(self):
        data = request(assignments=[assignment('2026-10-03', locked=False), assignment('2026-10-04', locked=False)],
                       adjacency=['early'], weekly=[('early', 0)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])

    def test_fixed_adjacent_boundaries_include_unlocked_history_and_cross_year(self):
        for month, left, right in [('2026-10', '2026-09-30', '2026-10-01'),
                                   ('2026-10', '2026-10-31', '2026-11-01'),
                                   ('2027-01', '2026-12-31', '2027-01-01')]:
            with self.subTest(month=month, left=left):
                data = request(month=month, assignments=[assignment(left, locked=left.startswith(month)), assignment(right, locked=right.startswith(month))], adjacency=['early'])
                self.assertConflict(solve(data), 'consecutive-shift')

    def test_distant_history_does_not_trigger_new_rules(self):
        data = request(assignments=[assignment('2026-08-03', locked=False), assignment('2026-08-04', locked=False)],
                       adjacency=['early'], weekly=[('early', 0)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], data['state']['assignments'])

    def test_adjacent_external_history_in_touching_week_is_checked_as_full_week(self):
        data = request(assignments=[assignment('2026-09-28', locked=False), assignment('2026-09-29', locked=False)], adjacency=['early'])
        self.assertConflict(solve(data), 'consecutive-shift')

    def test_adjacency_applies_across_sunday_monday(self):
        data = request(assignments=[assignment('2026-10-04'), assignment('2026-10-05')], adjacency=['early'])
        self.assertConflict(solve(data), 'consecutive-shift')

    def test_candidate_adjacency_and_boundary_history_are_enforced(self):
        data = request(shifts=[shift(required=1)], employees=[employee('a'), employee('b')], adjacency=['early'],
                       assignments=[assignment('2026-09-30', eid='a', locked=False), assignment('2026-11-01', eid='a', locked=False)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)
        self.assertFalse(any(record['employeeId'] == 'a' and record['date'] in ('2026-10-01', '2026-10-31') for record in result['assignments']))

    def test_infeasible_candidate_adjacency_has_rule_diagnostic(self):
        self.assertConflict(solve(request(shifts=[shift(required=1)], adjacency=['early'])), 'consecutive-shift')

    def test_partial_coverage_does_not_relax_adjacency(self):
        data = request(shifts=[shift(required=1)], adjacency=['early'], partial=True)
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)
        self.assertEqual(len(result['assignments']), 16)
        self.assertEqual(result['stats']['shortageCount'], 15)

    def test_fixed_weekly_count_has_exact_proof_including_previous_and_future_month(self):
        cases = [('2026-10', ['2026-09-28', '2026-10-01']),
                 ('2026-10', ['2026-10-30', '2026-11-01']),
                 ('2027-01', ['2026-12-31', '2027-01-01'])]
        for month, dates in cases:
            with self.subTest(month=month, dates=dates):
                data = request(month=month, assignments=[assignment(date, locked=date.startswith(month)) for date in dates], weekly=[('early', 1)])
                result = solve(data)
                self.assertConflict(result, 'weekly-shift-limit')
                self.assertTrue(any('2 次' in issue['message'] and '1 次' in issue['message'] for issue in result['issues']))

    def test_weekly_limit_includes_fixed_history_even_without_active_month_work(self):
        data = request(assignments=[assignment('2026-09-28', locked=False), assignment('2026-09-29', locked=False)], weekly=[('early', 1)])
        self.assertConflict(solve(data), 'weekly-shift-limit')

    def test_duplicate_record_is_not_misreported_as_two_weekly_starts(self):
        data = request(assignments=[assignment('2026-10-01'), assignment('2026-10-01')], weekly=[('early', 1)])
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertTrue(any(issue['type'] == 'duplicate' for issue in result['issues']))
        self.assertFalse(any(issue['type'] == 'weekly-shift-limit' for issue in result['issues']))

    def test_partial_week_is_not_prorated(self):
        records = [assignment('2026-10-01'), assignment('2026-10-02'), assignment('2026-10-03')]
        data = request(assignments=records, weekly=[('early', 3)])
        self.assertFeasible(solve(data))

    def test_overnight_sunday_belongs_to_start_week_not_monday(self):
        records = [assignment('2026-10-04', 'night'), assignment('2026-10-05', 'night')]
        data = request(employees=[employee('a', ['night'])], shifts=[shift('night', start='22:00', end='06:00')],
                       assignments=records, weekly=[('night', 1)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)

    def test_previous_sunday_overnight_does_not_use_current_monday_quota(self):
        data = request(month='2026-06', employees=[employee('a', ['night'])], shifts=[shift('night', start='22:00', end='06:00')],
                       assignments=[assignment('2026-05-31', 'night', locked=False), assignment('2026-06-01', 'night')], weekly=[('night', 1)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)

    def test_candidate_weekly_limit_counts_history_both_month_boundaries(self):
        data = request(employees=[employee('a'), employee('b'), employee('c'), employee('d')], shifts=[shift(required=1)],
                       assignments=[assignment('2026-09-28', locked=False), assignment('2026-11-01', locked=False)], weekly=[('early', 2)])
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)
        self.assertEqual(len(result['assignments']), 33)

    def test_weekly_zero_prohibits_selected_shift_even_when_partial_allowed(self):
        data = request(shifts=[shift(required=1)], weekly=[('early', 0)], partial=True)
        result = solve(data)
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])
        self.assertEqual(result['stats']['shortageCount'], 31)
        data['state']['assignments'] = [assignment('2026-10-01')]
        self.assertConflict(solve(data), 'weekly-shift-limit')

    def test_strict_weekly_zero_has_rule_diagnostic(self):
        self.assertConflict(solve(request(shifts=[shift(required=1)], weekly=[('early', 0)])), 'weekly-shift-limit')

    def test_weekly_seven_allows_every_date_in_full_week(self):
        data = request(assignments=[assignment(f'2026-10-{day:02d}') for day in range(5, 12)], weekly=[('early', 7)])
        self.assertFeasible(solve(data))

    def test_multiple_rules_apply_to_every_member_and_selected_shift(self):
        shifts = [shift('early', required=1), shift('night', required=1, start='22:00', end='06:00')]
        employees = [employee(name, ['early', 'night']) for name in ('a', 'b', 'c', 'd', 'e')]
        data = request(shifts=shifts, employees=employees, adjacency=['early', 'night'], weekly=[('early', 2), ('night', 2)])
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertFeasible(result)
        self.assertCalendarRules(data, result)
        self.assertEqual(len(result['assignments']), 62)
        self.assertEqual(data, original)

    def test_unknown_result_is_not_reported_as_infeasible(self):
        data = request(shifts=[shift(required=1)], adjacency=['early'], weekly=[('early', 2)])
        with patch('engine.cp_model.CpSolver.solve', return_value=cp_model.UNKNOWN):
            result = solve(data)
        self.assertEqual(result['status'], 'UNKNOWN', result)
        self.assertNotIn('assignments', result)
        self.assertTrue(any(issue['type'] == 'timeout' for issue in result['issues']))


if __name__ == '__main__':
    unittest.main()
