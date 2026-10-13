import copy
import datetime as dt
import json
from pathlib import Path
import subprocess
import shutil
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve, weekday_targets


def employee(eid, eligible=None, cap=48, leave=None, minimum_month=0, minimum_week=0):
    return dict(id=eid, name=eid, role='', group='', color='#123456', minHoursPerMonth=minimum_month, minHoursPerWeek=minimum_week, maxHoursPerWeek=cap, eligibleShiftIds=eligible or ['early'], unavailableDates=leave or [])


def shift(sid='early', start='08:00', end='16:00', required=1):
    return dict(id=sid, name=sid, shortName=sid, color='#123456', start=start, end=end, required=required)


def state(employees=None, shifts=None, month='2026-10', assignments=None, **rules):
    return dict(version=1, teamName='测试', month=month, employees=employees or [employee('a'), employee('b')], shifts=shifts or [shift()], assignments=assignments or [], rules=dict(minRestHours=11, maxConsecutiveDays=6, balanceWeekends=True, separationGroups=[], **rules))


def request(s, **options):
    return dict(protocolVersion=1, requestId='test-1', state=s, options=dict(timeLimitSeconds=3, seed=1010, allowPartial=False, **options))


def assignment(eid, date, sid='early', locked=True):
    return dict(employeeId=eid, date=date, shiftId=sid, locked=locked)


def actual_month_minutes(s, assignments, eid):
    """Independent minute-by-minute oracle for monthly / natural-week totals."""
    shifts = {item['id']: item for item in s['shifts']}
    weekly = {}
    total = 0
    for item in assignments:
        if item['employeeId'] != eid or item['shiftId'] == 'off':
            continue
        shift = shifts[item['shiftId']]
        start = dt.datetime.fromisoformat(f'{item["date"]}T{shift["start"]}')
        end = dt.datetime.fromisoformat(f'{item["date"]}T{shift["end"]}')
        if end <= start:
            end += dt.timedelta(days=1)
        minute = start
        while minute < end:
            if minute.strftime('%Y-%m') == s['month']:
                week = (minute.date() - dt.timedelta(days=minute.weekday())).isoformat()
                weekly[week] = weekly.get(week, 0) + 1
                total += 1
            minute += dt.timedelta(minutes=1)
    return total, weekly


def weekly_team_counts(s, assignments):
    """Count shift starts in the editable month without solver helpers."""
    result = {}
    for item in assignments:
        if item['shiftId'] == 'off' or not item['date'].startswith(s['month'] + '-'):
            continue
        date = dt.date.fromisoformat(item['date'])
        week = (date - dt.timedelta(days=date.weekday())).isoformat()
        by_day, by_shift = result.setdefault(week, ({}, {}))
        by_day[item['date']] = by_day.get(item['date'], 0) + 1
        by_shift[item['shiftId']] = by_shift.get(item['shiftId'], 0) + 1
    return result


class SolverTest(unittest.TestCase):
    def assertFeasible(self, result):
        self.assertIn(result['status'], ['OPTIMAL', 'FEASIBLE'], result)
        self.assertIn('assignments', result)

    def test_basic_fair_coverage(self):
        data = request(state())
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 31)
        self.assertEqual(result['stats']['shortageCount'], 0)
        self.assertEqual(data, original)
        self.assertEqual(result['requestId'], 'test-1')

    def test_locked_off_preserved(self):
        off = assignment('a', '2026-10-01', 'off')
        result = solve(request(state(assignments=[off])))
        self.assertFeasible(result)
        self.assertIn(off, result['assignments'])
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] == off['date'] and a['shiftId'] != 'off' for a in result['assignments']))

    def test_infeasible_never_returns_replacement(self):
        result = solve(request(state(employees=[employee('a', cap=0)])))
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)

    def test_explicit_partial_has_shortages_not_relaxed_hard_rules(self):
        data = request(state(employees=[employee('a', cap=0)]))
        data['options']['allowPartial'] = True
        result = solve(data)
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])
        self.assertEqual(result['stats']['shortageCount'], 31)
        self.assertEqual(len(result['issues']), 31)

    def test_fixed_qualification_conflict(self):
        data = request(state(shifts=[shift(), shift('night', '23:00', '07:00', 0)], assignments=[assignment('a', '2026-10-01', 'night')]))
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)

    def test_previous_month_overnight_leave_conflict(self):
        employees = [employee('a', ['night'], leave=['2026-10-01']), employee('b', ['night'])]
        s = state(employees=employees, shifts=[shift('night', '23:00', '07:00')], assignments=[assignment('a', '2026-09-30', 'night', False)])
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'unavailable' for i in result['issues']))

    def test_overnight_leave_prevents_previous_start_day(self):
        employees = [employee('a', ['night'], leave=['2026-10-02']), employee('b', ['night']), employee('c', ['night'])]
        result = solve(request(state(employees=employees, shifts=[shift('night', '23:00', '07:00')])))
        self.assertFeasible(result)
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] in ['2026-10-01', '2026-10-02'] for a in result['assignments']))

    def test_natural_week_split_cross_month(self):
        # Sunday May 31: one hour belongs to May's week, seven to Monday June 1 week.
        employees = [employee('a', ['night'], cap=7), employee('b', ['night'], cap=168)]
        s = state(month='2026-06', employees=employees, shifts=[shift('night', '23:00', '07:00')], assignments=[assignment('a', '2026-05-31', 'night', False)])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertIn(s['assignments'][0], result['assignments'])
        self.assertFalse(any(a['employeeId'] == 'a' and '2026-06-01' <= a['date'] <= '2026-06-06' for a in result['assignments']))

    def test_cross_month_rest_and_consecutive(self):
        previous = [assignment('a', f'2026-09-{day}', locked=False) for day in range(25, 31)]
        result = solve(request(state(assignments=previous)))
        self.assertFeasible(result)
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] == '2026-10-01' for a in result['assignments']))

    def test_adjacent_month_rest_and_future_history(self):
        employees = [employee('a', ['early', 'night']), employee('b', ['early', 'night']), employee('c', ['early', 'night']), employee('d', ['early', 'night'])]
        fixed = [assignment('a', '2026-09-30', 'night', False), assignment('b', '2026-11-01', 'early', False)]
        s = state(employees=employees, shifts=[shift(), shift('night', '23:00', '07:00')], assignments=fixed)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in fixed))
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] == '2026-10-01' and a['shiftId'] == 'early' for a in result['assignments']))
        self.assertFalse(any(a['employeeId'] == 'b' and a['date'] == '2026-10-31' and a['shiftId'] == 'night' for a in result['assignments']))

    def test_fixed_weekly_actual_minutes_detected(self):
        s = state(month='2026-06', employees=[employee('a', ['night'], cap=7)], shifts=[shift('night', '23:00', '07:00')], assignments=[assignment('a', '2026-05-31', 'night', False), assignment('a', '2026-06-07', 'night')])
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'weekly-hours' for i in result['issues']))

    def test_separation_hard_and_partial(self):
        s = state(shifts=[shift(required=2)])
        s['rules']['separationGroups'] = [dict(id='g', name='不能同班', employeeIds=['a', 'b'], shiftIds=[])]
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        r = request(s)
        r['options']['allowPartial'] = True
        result = solve(r)
        self.assertFeasible(result)
        self.assertGreaterEqual(result['stats']['shortageCount'], 31)
        per_day = {}
        for a in result['assignments']:
            per_day[a['date']] = per_day.get(a['date'], 0) + 1
        self.assertTrue(all(count <= 1 for count in per_day.values()))

    def test_fixed_separation_fails_before_solving(self):
        s = state(shifts=[shift(required=2)], assignments=[assignment('a', '2026-10-01'), assignment('b', '2026-10-01')])
        s['rules']['separationGroups'] = [dict(id='g', name='分开', employeeIds=['a', 'b'], shiftIds=['early'])]
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'separation' for i in result['issues']))

    def test_duplicate_fixed_off_fails(self):
        result = solve(request(state(assignments=[assignment('a', '2026-10-01', 'off'), assignment('a', '2026-10-01')])))
        self.assertEqual(result['status'], 'INFEASIBLE')

    def test_fractional_week_limit_rounded_down(self):
        s = state(employees=[employee('a', cap=7.999), employee('b', cap=168)])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertFalse(any(a['employeeId'] == 'a' for a in result['assignments']))

    def test_monthly_minimum_changes_assignment_distribution(self):
        s = state(employees=[employee('a', cap=168, minimum_month=160), employee('b', cap=168)])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertGreaterEqual(actual_month_minutes(s, result['assignments'], 'a')[0], 160 * 60)

    def test_total_monthly_minimum_exceeding_demand_is_explained(self):
        s = state(employees=[employee('a', minimum_month=160), employee('b', minimum_month=160)])
        original = copy.deepcopy(s)
        for allow_partial in (False, True):
            r = request(s)
            r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)
            self.assertIn('248', result['issues'][0]['message'])
            self.assertIn('320', result['issues'][0]['message'])
            self.assertEqual(result['issues'][0]['type'], 'monthly-min-hours')
        self.assertEqual(s, original)

    def test_individual_unreachable_monthly_minimum_is_explained(self):
        leaves = [f'2026-10-{day:02d}' for day in range(1, 32)]
        s = state(employees=[employee('a', leave=leaves, minimum_month=8), employee('b', cap=168)])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'monthly-min-hours' and i.get('employeeId') == 'a' for i in result['issues']))
        self.assertNotIn('assignments', result)

    def test_weekly_minimum_prorates_both_month_boundaries(self):
        s = state(employees=[employee('a', cap=7, minimum_week=7)], shifts=[shift(start='12:00', end='13:00')])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        total, weekly = actual_month_minutes(s, result['assignments'], 'a')
        self.assertEqual(total, 31 * 60)
        self.assertEqual(weekly, {'2026-09-28': 240, '2026-10-05': 420, '2026-10-12': 420, '2026-10-19': 420, '2026-10-26': 360})

    def test_minimum_rounding_uses_ceil_then_partial_week_ceil(self):
        # .02 hours becomes two minutes, then the first 4/7 week still
        # requires two minutes, rather than rounding .02 * 60 * 4/7 to one.
        s = state(employees=[employee('a', cap=1, minimum_month=.02, minimum_week=.02), employee('b', cap=1)], shifts=[shift(start='12:00', end='12:01')])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        total, weekly = actual_month_minutes(s, result['assignments'], 'a')
        self.assertGreaterEqual(total, 2)
        self.assertTrue(all(weekly.get(week, 0) >= 2 for week in ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']))

    def test_outside_month_work_cannot_satisfy_prorated_week_minimum(self):
        outside = [assignment('a', f'2026-09-{day}', locked=False) for day in (28, 29, 30)]
        leaves = [f'2026-10-{day:02d}' for day in (1, 2, 3, 4)]
        s = state(employees=[employee('a', cap=168, minimum_week=28, leave=leaves), employee('b', cap=168)], assignments=outside)
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        first = [i for i in result['issues'] if i['type'] == 'weekly-min-hours' and i.get('date') == '2026-09-28']
        self.assertTrue(first)
        self.assertIn('16 小时', first[0]['message'])
        self.assertIn('0 小时', first[0]['message'])

    def test_overnight_month_minimum_counts_carry_in_excludes_carry_out(self):
        s = state(employees=[employee('a', ['night'], cap=168, minimum_month=248)], shifts=[shift('night', '23:00', '07:00')], assignments=[assignment('a', '2026-09-30', 'night', False)])
        s['rules']['maxConsecutiveDays'] = 32
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(actual_month_minutes(s, result['assignments'], 'a')[0], 248 * 60)
        s['assignments'] = []
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertIn('241', result['issues'][0]['message'])

    def test_previous_month_night_tail_satisfies_first_partial_week_minimum(self):
        # February 2026 begins on Sunday: 7/7 = one hour is needed in February,
        # supplied by the Saturday night shift's seven-hour Sunday tail.
        leaves = [f'2026-02-{day:02d}' for day in (2, 3, 4, 5, 6)]
        fixed = [assignment('a', '2026-01-31', 'night', False), assignment('a', '2026-02-01', 'off')]
        s = state(month='2026-02', employees=[employee('a', ['night'], cap=168, minimum_week=7, leave=leaves), employee('b', ['night'], cap=168)], shifts=[shift('night', '23:00', '07:00')], assignments=fixed)
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        _, weekly = actual_month_minutes(s, result['assignments'], 'a')
        self.assertEqual(weekly['2026-01-26'], 420)

    def test_locked_off_week_minimum_not_relaxed_by_allow_partial(self):
        locked = [assignment('a', f'2026-10-{day:02d}', 'off') for day in range(5, 12)]
        s = state(employees=[employee('a', cap=168, minimum_week=8), employee('b', cap=168)], assignments=locked)
        s['rules']['maxConsecutiveDays'] = 31
        r = request(s)
        r['options']['allowPartial'] = True
        result = solve(r)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)
        self.assertTrue(any(i['type'] == 'weekly-min-hours' and i.get('date') == '2026-10-05' for i in result['issues']))

    def test_missing_minimum_fields_remain_backward_compatible(self):
        s = state()
        for e in s['employees']:
            del e['minHoursPerMonth']
            del e['minHoursPerWeek']
        self.assertFeasible(solve(request(s)))

    def test_invalid_minimum_fields_and_rounded_week_range(self):
        cases = [('minHoursPerMonth', None), ('minHoursPerMonth', -1), ('minHoursPerMonth', 745), ('minHoursPerMonth', True), ('minHoursPerMonth', float('inf')), ('minHoursPerWeek', None), ('minHoursPerWeek', -1), ('minHoursPerWeek', 169), ('minHoursPerWeek', 49)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                s = state()
                s['employees'][0][field] = value
                self.assertEqual(solve(request(s))['status'], 'MODEL_INVALID')
        s = state(employees=[employee('a', cap=.025, minimum_week=.025)])
        self.assertEqual(solve(request(s))['status'], 'MODEL_INVALID')

    def test_weekday_weights_ceiling_once_for_team_not_per_shift(self):
        s = state(month='2026-02', employees=[employee(str(i), ['early', 'late'], cap=168) for i in range(6)], shifts=[shift(), shift('late', '16:00', '23:00')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 20}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        counts = weekly_team_counts(s, result['assignments'])
        days, shifts = counts['2026-02-02']
        self.assertEqual(shifts, {'early': 7, 'late': 7})
        self.assertEqual(days.get('2026-02-02', 0) + days.get('2026-02-03', 0), 3)  # ceil(14 * .2), not 2 * ceil(7 * .2)
        self.assertLessEqual(abs(days.get('2026-02-02', 0) - days.get('2026-02-03', 0)), 1)
        remaining = [days.get(f'2026-02-{day:02d}', 0) for day in range(4, 9)]
        self.assertLessEqual(max(remaining) - min(remaining), 1)
        # Only Sunday remains in the first week: ceil(11 / 5)=3 total.
        # Equal shift remainders use stable input order, not random ties.
        self.assertEqual(counts['2026-01-26'][1], {'early': 2, 'late': 1})

    def test_partial_targets_match_user_example_and_largest_remainder(self):
        shifts = [shift(required=2), shift('late', '16:00', '23:00', 2), shift('night', '23:00', '07:00', 1)]
        config = {'days': [1, 6], 'percent': 40}
        # Complete week 35 -> selected 14, other 21. Missing Monday retains
        # Saturday's seven and all 21 others, rather than renormalizing to 35.
        tuesday_to_sunday = [dt.date(2026, 9, day).toordinal() for day in range(1, 7)]
        result = weekday_targets(config, tuesday_to_sunday, shifts)
        self.assertEqual(result[2:], (7, 21, {'early': 11, 'late': 11, 'night': 6}))
        # Also missing Tuesday: other share ceil(21*4/5)=17, total 24.
        wednesday_to_sunday = [dt.date(2026, 4, day).toordinal() for day in range(1, 6)]
        result = weekday_targets(config, wednesday_to_sunday, shifts)
        self.assertEqual(result[2:], (7, 17, {'early': 10, 'late': 9, 'night': 5}))

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent weekday-budget comparison')
    def test_weekday_budgets_match_frontend_across_partial_weeks(self):
        samples = []
        for month in ('2026-02', '2026-04', '2026-09', '2026-10'):
            for days, percent in (([1, 6], 40), ([6, 7], 50), ([1], 100), ([1], 0), (list(range(1, 8)), 100)):
                s = state(month=month, shifts=[shift(required=2), shift('late', '16:00', '23:00', 2), shift('night', '23:00', '07:00', 1)])
                s['rules']['weekdayWeights'] = {'days': days, 'percent': percent}
                samples.append(s)
        root = Path(__file__).resolve().parents[2]
        javascript = "import {readFileSync} from 'node:fs'; import {weightedWeeks} from './src/weekday-weights.ts'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(weightedWeeks)))"
        run = subprocess.run(['node', '--input-type=module', '-e', javascript], cwd=root, input=json.dumps(samples), text=True, encoding='utf-8', capture_output=True, check=True)
        for s, weeks in zip(samples, json.loads(run.stdout)):
            for week in weeks:
                _, _, selected, others, targets = weekday_targets(s['rules']['weekdayWeights'], [dt.date.fromisoformat(day).toordinal() for day in week['dates']], s['shifts'])
                self.assertEqual((selected, others, selected + others, targets), (week['selectedTarget'], week['otherTarget'], week['totalTarget'], week['shiftTargets']))

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_weighted_solution_matches_frontend_validator(self):
        s = state(month='2026-02', employees=[employee(str(i), ['early', 'late'], cap=168) for i in range(6)], shifts=[shift(), shift('late', '16:00', '23:00')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 20}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        check = Path(__file__).resolve().parent / 'crosscheck.mjs'
        validation = subprocess.run(['node', str(check)], input=json.dumps(dict(state=s, assignments=result['assignments'])), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    def test_weekday_weights_partial_week_keeps_absent_weekday_shares(self):
        s = state(month='2026-10', employees=[employee(str(i), cap=168) for i in range(5)])
        s['rules'].update(weekdayWeights={'days': [6, 7], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        counts = weekly_team_counts(s, result['assignments'])
        # Full week: weekend ceil(7*.5)=4, remaining 3. Thu-Sun
        # retains all four selected shifts and ceil(3*2/5)=2 other shifts.
        first, _ = counts['2026-09-28']
        self.assertEqual(first.get('2026-10-03', 0) + first.get('2026-10-04', 0), 4)
        self.assertEqual(sum(first.values()), 6)
        # Mon-Sat retains half of the selected four, and all three others.
        last, _ = counts['2026-10-26']
        self.assertEqual(last.get('2026-10-31', 0), 2)
        self.assertEqual(sum(last.values()), 5)

    def test_weighted_scarce_staff_and_partial_still_obey_hard_targets(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        self.assertEqual(solve(request(s))['status'], 'INFEASIBLE')
        r = request(s)
        r['options']['allowPartial'] = True
        result = solve(r)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)
        self.assertTrue(any(i['type'] == 'weekday-weights' for i in result['issues']))

    def test_weekday_weights_partial_does_not_relax_with_locked_ratio_conflict(self):
        locked = [assignment('a', '2026-06-02')]
        s = state(month='2026-06', employees=[employee(str(i), cap=168) for i in range(7)] + [employee('a', cap=168)], assignments=locked)
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        r = request(s)
        r['options']['allowPartial'] = True
        result = solve(r)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)

    def test_weighted_fixed_day_can_exceed_baseline_daily_required(self):
        locked = [assignment(str(i), '2026-06-01') for i in range(7)]
        s = state(month='2026-06', employees=[employee(str(i), cap=168) for i in range(7)], assignments=locked)
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in locked))
        self.assertEqual(len(result['assignments']), 35)

    def test_weighted_fixed_week_overstaffing_detected(self):
        locked = [assignment(str(i), '2026-06-01') for i in range(8)]
        s = state(month='2026-06', employees=[employee(str(i), cap=168) for i in range(8)], assignments=locked)
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'overstaffed' for i in result['issues']))

    def test_weighted_outside_month_assignments_preserved_without_entering_quota(self):
        prior = assignment('a', '2026-09-28', locked=False)
        s = state(month='2026-10', employees=[employee('a', cap=168), employee('b', cap=168), employee('c', cap=168)], assignments=[prior])
        s['rules'].update(weekdayWeights={'days': [6, 7], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertIn(prior, result['assignments'])
        first, _ = weekly_team_counts(s, result['assignments'])['2026-09-28']
        self.assertEqual(sum(first.values()), 6)
        self.assertEqual(first.get('2026-10-03', 0) + first.get('2026-10-04', 0), 4)

    def test_zero_weight_partial_week_remains_empty_without_redistribution(self):
        s = state(month='2026-02', employees=[employee(str(i), cap=168) for i in range(7)])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        for partial in (False, True):
            r = request(s)
            r['options']['allowPartial'] = partial
            result = solve(r)
            self.assertFeasible(result)
            self.assertFalse(any(a['date'] == '2026-02-01' for a in result['assignments']))
            self.assertEqual(len(result['assignments']), 28)
            self.assertEqual(result['stats']['shortageCount'], 0)

    def test_all_weekdays_at_100_percent_is_uniform(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)])
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 30)
        self.assertTrue(all(len(days) in (2, 7) and set(days.values()) == {1} for days, _ in weekly_team_counts(s, result['assignments']).values()))

    def test_weighted_monthly_capacity_does_not_reject_redistributed_nights(self):
        # Five Mondays retain seven shifts each, all ending in June. Counting
        # baseline daily demand or clipping a hypothetical June 30 shift would
        # undercount the 280 hours supplied by the weighted weekly targets.
        s = state(month='2026-06', employees=[employee(str(i), ['night'], cap=168, minimum_month=40) for i in range(7)], shifts=[shift('night', '23:00', '07:00')])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(sum(actual_month_minutes(s, result['assignments'], str(i))[0] for i in range(7)), 280 * 60)

    def test_invalid_weekday_weight_schemas_and_deprecated_switch(self):
        invalid = [None, {}, {'days': [], 'percent': 50}, {'days': [1, 1], 'percent': 50}, {'days': [0], 'percent': 50}, {'days': [8], 'percent': 50}, {'days': [True], 'percent': 50}, {'days': [1], 'percent': -1}, {'days': [1], 'percent': 101}, {'days': [1], 'percent': 1.5}, {'days': list(range(1, 8)), 'percent': 99}]
        for weights in invalid:
            with self.subTest(weights=weights):
                s = state()
                s['rules']['weekdayWeights'] = weights
                self.assertEqual(solve(request(s))['status'], 'MODEL_INVALID')
        for value in (None, True, False, 'deprecated'):
            s = state()
            s['rules']['balanceWeekends'] = value
            self.assertFeasible(solve(request(s)))

    def test_invalid_nan_and_oversize(self):
        r = request(state())
        r['state']['rules']['minRestHours'] = float('nan')
        self.assertEqual(solve(r)['status'], 'MODEL_INVALID')
        r = request(state())
        r['state']['employees'] *= 201
        self.assertEqual(solve(r)['status'], 'MODEL_INVALID')

    def test_tiny_timeout_not_infeasible(self):
        s = state(employees=[employee(str(i), ['early', 'late', 'night']) for i in range(100)], shifts=[shift(), shift('late', '16:00', '23:00'), shift('night', '23:00', '07:00')])
        r = request(s)
        r['options']['timeLimitSeconds'] = .01
        result = solve(r)
        self.assertEqual(result['status'], 'UNKNOWN', result)
        self.assertNotIn('assignments', result)

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_default_twelve_person_model_matches_js_validator(self):
        folder = Path(__file__).resolve().parent
        fixture = subprocess.run(['node', str(folder / 'default_fixture.mjs')], text=True, encoding='utf-8', capture_output=True, check=True)
        s = json.loads(fixture.stdout)
        s['employees'][0]['unavailableDates'] = ['2026-10-02']
        s['rules']['separationGroups'] = [dict(id='separate', name='互斥', employeeIds=['employee-1', 'employee-2'], shiftIds=[])]
        s['assignments'] = [assignment('employee-3', '2026-09-30', 'night', False), assignment('employee-4', '2026-10-04', 'off')]
        r = request(s)
        r['options']['timeLimitSeconds'] = 5
        result = solve(r)
        self.assertFeasible(result)
        self.assertEqual(result['stats']['shortageCount'], 0)
        validation = subprocess.run(['node', str(folder / 'crosscheck.mjs')], input=json.dumps(dict(state=s, assignments=result['assignments'])), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    @unittest.skipUnless(shutil.which('node'), 'Node required for frontend reference resolution')
    def test_frontend_reference_defaults_resolve_before_solver_and_explain_capacity(self):
        folder = Path(__file__).resolve().parent
        fixture = subprocess.run(['node', str(folder / 'default_fixture.mjs'), '--reference'], text=True, encoding='utf-8', capture_output=True, check=True)
        s = json.loads(fixture.stdout)
        self.assertTrue(all(isinstance(e['minHoursPerMonth'], (int, float)) and e['minHoursPerMonth'] > 0 for e in s['employees']))
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertEqual(result['issues'][0]['type'], 'monthly-min-hours')
        self.assertNotIn('assignments', result)

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_positive_month_and_week_minimums_match_js_validator(self):
        s = state(employees=[employee('a', minimum_month=120, minimum_week=14), employee('b', minimum_month=120, minimum_week=14)])
        result = solve(request(s))
        self.assertFeasible(result)
        folder = Path(__file__).resolve().parent
        validation = subprocess.run(['node', str(folder / 'crosscheck.mjs')], input=json.dumps(dict(state=s, assignments=result['assignments'])), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])
        for eid in ('a', 'b'):
            total, weekly = actual_month_minutes(s, result['assignments'], eid)
            self.assertGreaterEqual(total, 120 * 60)
            self.assertGreaterEqual(weekly['2026-09-28'], 8 * 60)
            self.assertGreaterEqual(weekly['2026-10-26'], 12 * 60)

    def test_cli_stdout_single_json_and_info(self):
        main = Path(__file__).resolve().parents[1] / 'main.py'
        result = subprocess.run([sys.executable, str(main)], input=json.dumps(request(state())), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertFeasible(json.loads(result.stdout))
        self.assertEqual(len(result.stdout.strip().splitlines()), 1)
        info = subprocess.run([sys.executable, str(main), '--info'], text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(info.stdout)['engine'], 'ortools-cp-sat')

    def test_hosted_stages_do_not_contaminate_result_json(self):
        main = Path(__file__).resolve().parents[1] / 'main.py'
        result = subprocess.run([sys.executable, str(main), '--hosted'], input=json.dumps(request(state())), text=True, encoding='utf-8', capture_output=True, check=True, timeout=15)
        self.assertFeasible(json.loads(result.stdout))
        self.assertEqual(len(result.stdout.strip().splitlines()), 1)
        stages = [line for line in result.stderr.splitlines() if line.startswith('SHIFTFLOW_STAGE_V1:')]
        self.assertEqual(stages, [f'SHIFTFLOW_STAGE_V1:{name}' for name in ['loading', 'reading', 'solving', 'finishing']])

    def test_native_self_test_actually_completes_constraint_search(self):
        main = Path(__file__).resolve().parents[1] / 'main.py'
        result = subprocess.run([sys.executable, str(main), '--hosted', '--self-test'], text=True, encoding='utf-8', capture_output=True, check=True, timeout=15)
        info = json.loads(result.stdout)
        self.assertEqual(info['engine'], 'ortools-cp-sat')
        self.assertIs(info['selfTest'], True)
        self.assertEqual(info['status'], 'OPTIMAL')
        self.assertIn('SHIFTFLOW_STAGE_V1:solving', result.stderr)
        self.assertTrue(result.stderr.rstrip().endswith('SHIFTFLOW_STAGE_V1:finishing'))


if __name__ == '__main__':
    unittest.main()
