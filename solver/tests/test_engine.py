import copy
import datetime as dt
import json
import math
from pathlib import Path
import subprocess
import shutil
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve, weekday_targets


def employee(eid, eligible=None, cap=48, leave=None, minimum_month=0, minimum_week=0):
    return dict(id=eid, name=eid, role='', group='', color='#123456', minHoursPerMonth=minimum_month, minHoursPerWeek=minimum_week, maxHoursPerWeek=cap, eligibleShiftIds=eligible or ['early'], unavailableDates=leave or [])


def shift(sid='early', start='08:00', end='16:00', required=1, mode=None):
    value = dict(id=sid, name=sid, shortName=sid, color='#123456', start=start, end=end, required=required)
    if mode is not None:
        value['staffingMode'] = mode
    return value


def state(employees=None, shifts=None, month='2026-10', assignments=None, **rules):
    return dict(version=1, teamName='测试', month=month, employees=employees or [employee('a'), employee('b')], shifts=shifts or [shift()], assignments=assignments or [], rules=dict(minRestHours=11, maxConsecutiveDays=6, balanceWeekends=True, separationGroups=[], **rules))


def request(s, **options):
    return dict(protocolVersion=1, requestId='test-1', state=s, options=dict(timeLimitSeconds=3, seed=1010, allowPartial=False, **({'referenceDate': '2030-01-01'} | options)))


def assignment(eid, date, sid='early', locked=True):
    return dict(employeeId=eid, date=date, shiftId=sid, locked=locked)


def confirm_months(s, *months):
    """Fixture metadata explicitly confirms blank dates as rest for every member."""
    s.setdefault('scheduleCoverage', {}).update({month: {'employeeIds': [e['id'] for e in s['employees']]} for month in months})


def actual_month_minutes(s, assignments, eid, *, include_outside=False):
    """Independent minute oracle, optionally including complete boundary weeks."""
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
            if include_outside or minute.strftime('%Y-%m') == s['month']:
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
        self.assertEqual(len([item for item in result['issues'] if item['type'] == 'coverage']), 31)

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

    def test_legacy_monthly_values_do_not_change_weekly_constraints_or_staffing(self):
        # Each of the five natural weeks needs exactly one eight-hour shift.
        # Legacy values must neither reject this request nor add more work.
        for legacy in (None, 0, 160, 1000000, -1, True, float('inf'), 'obsolete', {'old': 1}):
            with self.subTest(legacy=legacy):
                s = state(employees=[employee('a', cap=8, minimum_week=8, minimum_month=legacy)],
                          shifts=[shift(required=0)])
                original = copy.deepcopy(s)
                result = solve(request(s))
                self.assertFeasible(result)
                self.assertEqual(len(result['assignments']), 5)
                self.assert_prorated_weekly_hours(s, result['assignments'], 'a')
                self.assertEqual(s, original)

    def test_high_legacy_monthly_minimum_does_not_make_zero_weekly_capacity_infeasible(self):
        s = state(employees=[employee('a', cap=0, minimum_month=1000000)], shifts=[shift(required=0)])
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])

    def test_weekly_minimum_can_add_people_above_daily_minimum(self):
        s = state(employees=[employee('a', minimum_week=40), employee('b', minimum_week=40)])
        original = copy.deepcopy(s)
        for allow_partial in (False, True):
            r = request(s)
            r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertFeasible(result)
            self.assertEqual(len(result['assignments']), 46)
            for eid in ('a', 'b'):
                self.assert_prorated_weekly_hours(s, result['assignments'], eid)
            self.assert_daily_minimum(s, result['assignments'])
        self.assertEqual(s, original)

    def test_required_zero_is_available_for_extra_work_but_not_filled_without_a_reason(self):
        s = state(employees=[employee('a', minimum_week=8)], shifts=[shift(required=0)])
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 5)
        self.assert_prorated_weekly_hours(s, result['assignments'], 'a')
        s['employees'][0]['minHoursPerWeek'] = 0
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])

    def test_locked_assignments_above_minimum_and_on_zero_required_shift_remain_valid(self):
        locked = [assignment('a', '2026-10-01'), assignment('b', '2026-10-01')]
        s = state(assignments=locked)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in locked))
        self.assertEqual(len(result['assignments']), 32)
        s['shifts'][0]['required'] = 0
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], locked)

    def test_fixed_staffing_has_exact_daily_coverage(self):
        s = state(shifts=[shift(mode='fixed')])
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 31)
        self.assert_daily_minimum(s, result['assignments'])

    def test_fixed_and_minimum_shifts_can_mix_to_meet_employee_weekly_hours(self):
        s = state(employees=[employee(str(i), ['early', 'late'], minimum_week=20) for i in range(4)],
                  shifts=[shift(mode='fixed'), shift('late', '14:00', '22:00', 0, mode='minimum')])
        result = solve(request(s))
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assertEqual(sum(a['shiftId'] == 'early' for a in result['assignments']), 31)
        self.assertGreaterEqual(sum(a['shiftId'] == 'late' for a in result['assignments']), 25)
        for eid in map(str, range(4)):
            self.assert_prorated_weekly_hours(s, result['assignments'], eid)

    def test_fixed_zero_never_generates_work_and_cannot_supply_minimum_hours(self):
        old = assignment('a', '2026-10-01', locked=False)
        s = state(employees=[employee('a')], shifts=[shift(required=0, mode='fixed')], assignments=[old])
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(result['assignments'], [])
        self.assertEqual(s, original)
        s['employees'][0]['minHoursPerWeek'] = 8
        for allow_partial in (False, True):
            r = request(s); r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)
        s['shifts'][0]['staffingMode'] = 'minimum'
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 5)
        self.assert_prorated_weekly_hours(s, result['assignments'], 'a')

    def test_fixed_zero_locked_work_is_a_hard_conflict_even_when_shortage_is_allowed(self):
        locked = assignment('a', '2026-10-01')
        s = state(shifts=[shift(required=0, mode='fixed')], assignments=[locked])
        original = copy.deepcopy(s)
        for allow_partial in (False, True):
            r = request(s); r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)
            self.assertTrue(any(item['type'] == 'overstaffed' for item in result['issues']))
        self.assertEqual(s, original)

    def test_fixed_locked_overstaffing_rejects_instead_of_removing_a_locked_employee(self):
        locked = [assignment('a', '2026-10-01'), assignment('b', '2026-10-01')]
        s = state(shifts=[shift(mode='fixed')], assignments=locked)
        for allow_partial in (False, True):
            r = request(s); r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)
            self.assertTrue(any(item['type'] == 'overstaffed' for item in result['issues']))

    def test_fixed_daily_count_cannot_expand_to_bypass_weekly_minimum_conflicts(self):
        s = state(employees=[employee('a', minimum_week=40), employee('b', minimum_week=40)],
                  shifts=[shift(mode='fixed')])
        for allow_partial in (False, True):
            r = request(s); r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)
            self.assertTrue(any(item['type'] == 'weekly-fixed-capacity' for item in result['issues']))

    def test_fixed_partial_allows_understaffing_but_preserves_the_daily_ceiling(self):
        s = state(employees=[employee('a', cap=168), employee('b', cap=168)], shifts=[shift(required=3, mode='fixed')])
        s['rules']['maxConsecutiveDays'] = 31
        self.assertEqual(solve(request(s))['status'], 'INFEASIBLE')
        r = request(s); r['options']['allowPartial'] = True
        result = solve(r)
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 62)
        self.assertEqual(result['stats']['shortageCount'], 31)
        counts = {}
        for a in result['assignments']:
            counts[a['date']] = counts.get(a['date'], 0) + 1
        self.assertEqual(set(counts.values()), {2})
        self.assertTrue(all('固定人数' in item['message'] for item in result['issues'] if item['type'] == 'coverage'))

    def test_legacy_missing_mode_and_explicit_minimum_both_allow_extra_assignments(self):
        for mode in (None, 'minimum'):
            s = state(employees=[employee('a', minimum_week=8)], shifts=[shift(required=0, mode=mode)])
            result = solve(request(s))
            self.assertFeasible(result)
            self.assertEqual(len(result['assignments']), 5)
            self.assert_prorated_weekly_hours(s, result['assignments'], 'a')

    def test_invalid_staffing_modes_are_rejected_without_a_replacement(self):
        for mode in (None, 0, 1, True, False, {}, [], '', 'Fixed', 'minimum ', 'maximum'):
            with self.subTest(mode=mode):
                s = state()
                s['shifts'][0]['staffingMode'] = mode
                result = solve(request(s))
                self.assertEqual(result['status'], 'MODEL_INVALID')
                self.assertNotIn('assignments', result)
                self.assertIn('人数模式', result['message'])

    def test_current_fixed_count_does_not_rewrite_outside_month_history(self):
        history = [assignment('a', '2026-09-30', locked=False), assignment('b', '2026-09-30', locked=False)]
        s = state(shifts=[shift(mode='fixed')], assignments=history)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in history))
        self.assert_daily_minimum(s, result['assignments'])

    def test_extra_staffing_preserves_separation_and_cannot_relax_weekly_maxima(self):
        s = state(employees=[employee('a', minimum_week=40), employee('b', minimum_week=40)])
        s['rules']['separationGroups'] = [dict(id='g', name='分开', employeeIds=['a', 'b'], shiftIds=[])]
        self.assertEqual(solve(request(s))['status'], 'INFEASIBLE')
        # Five-hour shifts cannot meet an eight-hour weekly minimum without
        # breaching the eight-hour ceiling; allowing shortages cannot help.
        s = state(employees=[employee('a', minimum_week=8, cap=8)],
                  shifts=[shift(start='08:00', end='13:00', required=0)])
        for allow_partial in (False, True):
            r = request(s); r['options']['allowPartial'] = allow_partial
            result = solve(r)
            self.assertEqual(result['status'], 'INFEASIBLE')
            self.assertNotIn('assignments', result)

    def test_individual_unreachable_weekly_minimum_is_explained(self):
        leaves = [f'2026-10-{day:02d}' for day in range(1, 32)]
        s = state(employees=[employee('a', leave=leaves, minimum_week=8), employee('b', cap=168)])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertTrue(any(i['type'] == 'weekly-min-hours' and i.get('employeeId') == 'a' for i in result['issues']))
        self.assertNotIn('assignments', result)

    def test_weekly_minimum_prorates_only_unconfirmed_historical_boundary_dates(self):
        s = state(employees=[employee('a', cap=7, minimum_week=7)], shifts=[shift(start='12:00', end='13:00')])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        total, weekly = actual_month_minutes(s, result['assignments'], 'a')
        self.assertEqual(total, 31 * 60)
        self.assertEqual(weekly, {'2026-09-28': 240, '2026-10-05': 420, '2026-10-12': 420, '2026-10-19': 420, '2026-10-26': 360})
        self.assertEqual(len(result['boundaryContext']['incompleteHistory']), 2)
        self.assertEqual(result['boundaryPreview'], [])

    def test_minimum_rounding_uses_ceil_then_partial_week_ceil(self):
        # .02 hours becomes two minutes, then the first 4/7 week still
        # requires two minutes, rather than rounding .02 * 60 * 4/7 to one.
        s = state(employees=[employee('a', cap=1, minimum_week=.02), employee('b', cap=1)], shifts=[shift(start='12:00', end='12:01')])
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertFeasible(result)
        _, weekly = actual_month_minutes(s, result['assignments'], 'a')
        self.assertTrue(all(weekly.get(week, 0) >= 2 for week in ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']))

    def test_outside_month_work_reduces_but_does_not_erase_remaining_week_minimum(self):
        outside = [assignment('a', f'2026-09-{day}', locked=False) for day in (28, 29, 30)]
        leaves = [f'2026-10-{day:02d}' for day in (1, 2, 3, 4)]
        s = state(employees=[employee('a', cap=168, minimum_week=28, leave=leaves), employee('b', cap=168)], assignments=outside)
        s['rules']['maxConsecutiveDays'] = 31
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        first = [i for i in result['issues'] if i['type'] == 'weekly-min-hours' and i.get('date') == '2026-09-28']
        self.assertTrue(first)
        self.assertIn('本周实际最低要求 28 小时', first[0]['message'])
        self.assertIn('已知固定工作 24 小时', first[0]['message'])
        self.assertIn('整周最多不超过 24 小时', first[0]['message'])
        self.assertIn('至少相差 4 小时', first[0]['message'])

    def test_previous_month_night_tail_satisfies_first_partial_week_minimum(self):
        # February 2026 begins on Sunday. Confirm January so the full week's
        # seven-hour minimum applies; one Saturday hour plus seven Sunday tail
        # hours cover it without generating a second start on Sunday.
        leaves = [f'2026-02-{day:02d}' for day in (2, 3, 4, 5, 6)]
        fixed = [assignment('a', '2026-01-31', 'night', False), assignment('a', '2026-02-01', 'off')]
        s = state(month='2026-02', employees=[employee('a', ['night'], cap=168, minimum_week=7, leave=leaves), employee('b', ['night'], cap=168)], shifts=[shift('night', '23:00', '07:00')], assignments=fixed)
        s['scheduleCoverage'] = {'2026-01': {'employeeIds': ['a', 'b']}}
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

    def test_invalid_weekly_minimum_and_rounded_week_range(self):
        for value in (None, -1, 169, 49, True, float('inf'), '8', {}):
            with self.subTest(value=value):
                s = state()
                s['employees'][0]['minHoursPerWeek'] = value
                self.assertEqual(solve(request(s))['status'], 'MODEL_INVALID')
        s = state(employees=[employee('a', cap=.025, minimum_week=.025)])
        self.assertEqual(solve(request(s))['status'], 'MODEL_INVALID')

    def assert_daily_minimum(self, s, assignments):
        counts = {}
        for item in assignments:
            key = (item['date'], item['shiftId'])
            counts[key] = counts.get(key, 0) + 1
        first = dt.date.fromisoformat(s['month'] + '-01')
        date = first
        while date.month == first.month:
            for item in s['shifts']:
                actual = counts.get((date.isoformat(), item['id']), 0)
                if item.get('staffingMode', 'minimum') == 'fixed':
                    self.assertEqual(actual, item['required'])
                else:
                    self.assertGreaterEqual(actual, item['required'])
            date += dt.timedelta(days=1)

    def assert_prorated_weekly_hours(self, s, assignments, eid, *, boundary_preview=(), reference_date='2030-01-01'):
        """Audit full-week actual minutes; only unknown past dates reduce the minimum."""
        person = next(item for item in s['employees'] if item['id'] == eid)
        first = dt.date.fromisoformat(s['month'] + '-01')
        weeks = set()
        date = first
        while date.month == first.month:
            weeks.add(date - dt.timedelta(days=date.weekday()))
            date += dt.timedelta(days=1)
        explicit = {(item['employeeId'], item['date']) for item in s['assignments']}
        reference = dt.date.fromisoformat(reference_date)
        _, full_weeks = actual_month_minutes(s, list(assignments) + list(boundary_preview), eid, include_outside=True)
        minimum = math.ceil(person.get('minHoursPerWeek', 0) * 60)
        maximum = math.floor(person['maxHoursPerWeek'] * 60)
        for week in weeks:
            days = [week + dt.timedelta(days=offset) for offset in range(7)]
            known = sum(day.strftime('%Y-%m') == s['month'] or day >= reference
                        or (eid, day.isoformat()) in explicit
                        or eid in s.get('scheduleCoverage', {}).get(day.strftime('%Y-%m'), {}).get('employeeIds', [])
                        for day in days)
            actual = full_weeks.get(week.isoformat(), 0)
            self.assertGreaterEqual(actual, (minimum * known + 6) // 7, (eid, week))
            self.assertLessEqual(actual, maximum, (eid, week))

    def test_weekly_oracle_audits_both_boundary_previews_without_persisting_them(self):
        s = state(month='2026-11', employees=[employee('a', cap=40, minimum_week=40)], shifts=[shift(required=0)])
        s['rules'].update(minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s, referenceDate='2026-10-01'))
        self.assertFeasible(result)
        self.assertTrue(any(item['date'] < '2026-11-01' for item in result['boundaryPreview']))
        self.assertTrue(any(item['date'] > '2026-11-30' for item in result['boundaryPreview']))
        self.assertTrue(all(item['date'].startswith('2026-11') for item in result['assignments']))
        self.assert_prorated_weekly_hours(s, result['assignments'], 'a', boundary_preview=result['boundaryPreview'], reference_date='2026-10-01')

    def assert_weighted_actual(self, s, assignments, *, boundary_preview=(), reference_date='2030-01-01'):
        weights = s['rules']['weekdayWeights']
        chosen = set(weights['days'])
        first = dt.date.fromisoformat(s['month'] + '-01')
        weeks = {}
        date = first
        while date.month == first.month:
            week = (date - dt.timedelta(days=date.weekday())).isoformat()
            weeks.setdefault(week, []).append(date)
            date += dt.timedelta(days=1)
        employee_ids = {item['id'] for item in s['employees']}
        explicit = {(item['employeeId'], item['date']) for item in s['assignments']}
        reference = dt.date.fromisoformat(reference_date)
        for week in weeks:
            start = dt.date.fromisoformat(week)
            days = [start + dt.timedelta(days=offset) for offset in range(7)]
            weeks[week] = [day for day in days if day.strftime('%Y-%m') == s['month'] or day >= reference
                           or all((eid, day.isoformat()) in explicit
                                  or eid in s.get('scheduleCoverage', {}).get(day.strftime('%Y-%m'), {}).get('employeeIds', [])
                                  for eid in employee_ids)]
        counts = {}
        for item in list(assignments) + list(boundary_preview):
            if item['employeeId'] in employee_ids and item['shiftId'] != 'off':
                counts[item['date']] = counts.get(item['date'], 0) + 1
        for week, days in weeks.items():
            by_day = {day.isoformat(): counts.get(day.isoformat(), 0) for day in days}
            selected = [by_day.get(day.isoformat(), 0) for day in days if day.weekday() + 1 in chosen]
            others = [by_day.get(day.isoformat(), 0) for day in days if day.weekday() + 1 not in chosen]
            for group in (selected, others):
                if group:
                    self.assertLessEqual(max(group) - min(group), 1)
            actual_s, actual_o = sum(selected), sum(others)
            candidates = [actual_s + actual_o] if len(days) == 7 else range(7 * len(s['employees']) + 1)
            matches = []
            for total in candidates:
                q = (total * weights['percent'] + 99) // 100
                target_s = (q * len(selected) + len(chosen) - 1) // len(chosen)
                other_count = 7 - len(chosen)
                target_o = ((total - q) * len(others) + other_count - 1) // other_count if other_count else 0
                if (target_s, target_o) == (actual_s, actual_o):
                    matches.append(total)
            self.assertTrue(matches, (week, by_day, weights))

    def test_weekday_weights_use_actual_team_total_and_keep_every_daily_shift_minimum(self):
        s = state(month='2026-02', employees=[employee(str(i), ['early', 'late'], cap=168) for i in range(6)], shifts=[shift(), shift('late', '16:00', '23:00')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 20}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        days, by_shift = weekly_team_counts(s, result['assignments'])['2026-02-02']
        total = sum(days.values())
        self.assertGreater(total, 14)  # 14 cannot cover both shifts on both selected weekdays.
        self.assertEqual(days.get('2026-02-02', 0) + days.get('2026-02-03', 0), (total * 20 + 99) // 100)
        self.assertTrue(all(count >= 7 for count in by_shift.values()))

    def test_fixed_daily_capacity_cannot_be_exceeded_to_satisfy_hard_weekday_weights(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)], shifts=[shift(mode='fixed')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)
        r = request(s); r['options']['allowPartial'] = True
        result = solve(r)
        self.assertFeasible(result)
        self.assert_weighted_actual(s, result['assignments'])
        self.assertGreater(result['stats']['shortageCount'], 0)
        counts = {}
        for a in result['assignments']:
            counts[a['date']] = counts.get(a['date'], 0) + 1
        self.assertTrue(all(count <= 1 for count in counts.values()))

    def test_mixed_staffing_modes_let_only_minimum_shift_expand_under_weekday_weights(self):
        s = state(month='2026-06', employees=[employee(str(i), ['early', 'late'], cap=168) for i in range(4)],
                  shifts=[shift(mode='fixed'), shift('late', '14:00', '22:00', 0, mode='minimum')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        self.assertEqual(sum(a['shiftId'] == 'early' for a in result['assignments']), 30)
        self.assertTrue(any(a['shiftId'] == 'late' for a in result['assignments']))

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_mixed_staffing_mode_solution_matches_frontend_validator(self):
        s = state(employees=[employee(str(i), ['early', 'late'], minimum_week=20) for i in range(4)],
                  shifts=[shift(mode='fixed'), shift('late', '14:00', '22:00', 0, mode='minimum')])
        result = solve(request(s))
        self.assertFeasible(result)
        check = Path(__file__).resolve().parent / 'crosscheck.mjs'
        validation = subprocess.run(['node', str(check)], input=json.dumps(dict(state=s, assignments=result['assignments'], boundaryPreview=result['boundaryPreview'], referenceDate='2030-01-01')), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    def test_partial_targets_preserve_user_example_shares_for_a_given_full_week_total(self):
        config = {'days': [1, 6], 'percent': 40}
        tuesday_to_sunday = [dt.date(2026, 9, day).toordinal() for day in range(1, 7)]
        self.assertEqual(weekday_targets(config, tuesday_to_sunday, 35)[2:], (7, 21))
        wednesday_to_sunday = [dt.date(2026, 4, day).toordinal() for day in range(1, 6)]
        self.assertEqual(weekday_targets(config, wednesday_to_sunday, 35)[2:], (7, 17))

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent weekday-budget comparison')
    def test_weekday_budgets_match_frontend_at_explicit_variable_full_totals(self):
        samples = []
        for month in ('2026-02', '2026-04', '2026-09', '2026-10'):
            for days, percent in (([1, 6], 40), ([6, 7], 50), ([1], 100), ([1], 0), (list(range(1, 8)), 100)):
                s = state(month=month)
                s['rules']['weekdayWeights'] = {'days': days, 'percent': percent}
                for full_total in (0, 7, 13, 35):
                    samples.append({'state': s, 'fullTotal': full_total})
        root = Path(__file__).resolve().parents[2]
        javascript = "import {readFileSync} from 'node:fs'; import {weightedWeeks} from './src/weekday-weights.ts'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(item=>weightedWeeks(item.state,item.fullTotal))))"
        run = subprocess.run(['node', '--input-type=module', '-e', javascript], cwd=root, input=json.dumps(samples), text=True, encoding='utf-8', capture_output=True, check=True)
        for sample, weeks in zip(samples, json.loads(run.stdout)):
            for week in weeks:
                _, _, selected, others = weekday_targets(sample['state']['rules']['weekdayWeights'], [dt.date.fromisoformat(day).toordinal() for day in week['dates']], sample['fullTotal'])
                self.assertEqual((selected, others, selected + others), (week['selectedTarget'], week['otherTarget'], week['totalTarget']))

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_weighted_solution_matches_frontend_validator(self):
        s = state(month='2026-02', employees=[employee(str(i), ['early', 'late'], cap=168) for i in range(6)], shifts=[shift(), shift('late', '16:00', '23:00')])
        s['rules'].update(weekdayWeights={'days': [1, 2], 'percent': 20}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        check = Path(__file__).resolve().parent / 'crosscheck.mjs'
        validation = subprocess.run(['node', str(check)], input=json.dumps(dict(state=s, assignments=result['assignments'], boundaryPreview=result['boundaryPreview'], referenceDate='2030-01-01')), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    def test_weekday_weights_boundary_weeks_keep_absent_shares_without_losing_daily_coverage(self):
        s = state(month='2026-10', employees=[employee(str(i), cap=168) for i in range(5)])
        s['rules'].update(weekdayWeights={'days': [6, 7], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        first, _ = weekly_team_counts(s, result['assignments'])['2026-09-28']
        self.assertGreaterEqual(first.get('2026-10-01', 0), 1)
        self.assertGreaterEqual(first.get('2026-10-02', 0), 1)

    def test_partial_coverage_may_relax_daily_minimum_but_never_the_weight_ratio(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        self.assertEqual(solve(request(s))['status'], 'INFEASIBLE')
        r = request(s); r['options']['allowPartial'] = True
        result = solve(r)
        self.assertFeasible(result)
        self.assert_weighted_actual(s, result['assignments'])
        self.assertTrue(all(dt.date.fromisoformat(a['date']).weekday() == 0 for a in result['assignments']))
        self.assertEqual(result['stats']['shortageCount'], 25)
        self.assertEqual(len(result['assignments']), 5)

    def test_locked_assignment_in_zero_weight_group_remains_infeasible_even_with_partial(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)], assignments=[assignment('a', '2026-06-02')])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        r = request(s); r['options']['allowPartial'] = True
        result = solve(r)
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)

    def test_weighted_locked_counts_above_old_total_are_feasible_with_extra_staffing(self):
        locked = [assignment(str(i), '2026-06-01') for i in range(8)]
        s = state(month='2026-06', employees=[employee(str(i), cap=168) for i in range(8)], shifts=[shift(required=0)], assignments=locked)
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in locked))
        self.assertEqual(len(result['assignments']), 8)
        self.assert_weighted_actual(s, result['assignments'])

    def test_weighted_previous_month_assignments_are_preserved_and_counted_in_first_week_quota(self):
        prior = assignment('a', '2026-09-28', locked=False)
        s = state(month='2026-10', employees=[employee('a', cap=168), employee('b', cap=168), employee('c', cap=168)], assignments=[prior])
        confirm_months(s, '2026-09')
        s['rules'].update(weekdayWeights={'days': [6, 7], 'percent': 50}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertIn(prior, result['assignments'])
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])

    def test_weighted_coherent_previous_week_counts_preserve_all_history(self):
        prior = [assignment('a', f'2026-09-{day}', locked=False) for day in (28, 29, 30)]
        prior += [assignment('b', '2026-09-01', 'off', False), assignment('a', '2026-11-01', 'off', False)]
        s = state(employees=[employee('a', cap=168), employee('b', cap=168)],
                  shifts=[shift(mode='fixed')], assignments=prior)
        confirm_months(s, '2026-09')
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(s, original)
        self.assertCountEqual([item for item in result['assignments'] if not item['date'].startswith(s['month'] + '-')], prior)
        self.assertEqual(sum(item['shiftId'] != 'off' and '2026-09-28' <= item['date'] <= '2026-10-04'
                             for item in result['assignments']), 7)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])

    def test_weighted_previous_counts_are_not_retroactively_limited_by_current_fixed_staffing(self):
        for prior_count in (0, 2):
            with self.subTest(prior_count=prior_count):
                prior = [assignment('a', '2026-09-01', 'off', False)]
                prior += [assignment(eid, f'2026-09-{day}', locked=False)
                          for day in (28, 29, 30) for eid in ('a', 'b')[:prior_count]]
                s = state(employees=[employee('a', cap=168), employee('b', cap=168)],
                          shifts=[shift(required=1, mode='fixed')], assignments=prior)
                confirm_months(s, '2026-09')
                s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
                result = solve(request(s))
                self.assertFeasible(result)
                self.assertCountEqual([item for item in result['assignments'] if not item['date'].startswith(s['month'] + '-')], prior)
                self.assert_daily_minimum(s, result['assignments'])
                self.assert_weighted_actual(s, result['assignments'])

    def test_weighted_incoherent_previous_counts_are_infeasible_even_with_partial_coverage(self):
        # Two starts on Monday and known zero on Tuesday cannot be made uniform
        # by any choices in the editable Thursday-Sunday part of the week.
        prior = [assignment('a', '2026-09-28', locked=False), assignment('b', '2026-09-28', locked=False)]
        s = state(employees=[employee('a', cap=168), employee('b', cap=168)],
                  shifts=[shift(mode='fixed')], assignments=prior)
        confirm_months(s, '2026-09')
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        original = copy.deepcopy(s)
        for allow_partial in (False, True):
            with self.subTest(allow_partial=allow_partial):
                r = request(s)
                r['options']['allowPartial'] = allow_partial
                result = solve(r)
                self.assertEqual(result['status'], 'INFEASIBLE', result)
                self.assertNotIn('assignments', result)
                self.assertEqual(s, original)

    def test_weighted_historical_group_ratio_is_checked_even_when_every_day_is_balanced(self):
        # A complete seven-day week with one start per day is evenly balanced,
        # but Mon/Sat's two starts do not meet ceil(7 * 40%) == three starts.
        current = [assignment('a', '2026-11-01'), assignment('b', '2026-11-01', 'off')]
        s = state(month='2026-11', employees=[employee('a', cap=168), employee('b', cap=168)],
                  assignments=current)
        s['rules'].update(weekdayWeights={'days': [1, 6], 'percent': 40}, minRestHours=0, maxConsecutiveDays=31)
        baseline = solve(request(s))
        self.assertFeasible(baseline)
        self.assert_weighted_actual(s, baseline['assignments'])
        s['assignments'] += [assignment('a', f'2026-10-{day}', locked=False) for day in range(26, 32)]
        confirm_months(s, '2026-10')
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        self.assertEqual(s, original)
        self.assertTrue(any(item['type'] == 'weekday-weight-capacity' and '合并已确认记录' in item['message']
                            for item in result['issues']), result)

    def test_weighted_remote_off_does_not_confirm_blank_days_without_explicit_coverage(self):
        s = state(employees=[employee(str(i), cap=168) for i in range(3)], shifts=[shift(required=2, mode='fixed')])
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        # Future and two-month-old records do not establish previous-month history.
        s['assignments'] = [assignment('0', '2026-08-31', 'off', False), assignment('1', '2026-11-01', 'off', False)]
        baseline = solve(request(s))
        self.assertFeasible(baseline)
        self.assert_weighted_actual(s, baseline['assignments'])
        # A single off record confirms only that date, not the boundary blanks.
        prior_off = assignment('2', '2026-09-01', 'off', False)
        s['assignments'].append(prior_off)
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertIn(prior_off, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        self.assertEqual(s, original)
        # Explicit completeness makes Mon-Wed known zero, incompatible with
        # the fixed two starts on Thu-Sun under the daily balance rule.
        confirm_months(s, '2026-09')
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        self.assertEqual(s, original)

    def test_weighted_january_uses_december_history_across_year_boundary(self):
        s = state(month='2027-01', employees=[employee(str(i), cap=168) for i in range(3)],
                  shifts=[shift(required=2, mode='fixed')])
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        self.assertFeasible(solve(request(s)))
        s['assignments'] = [assignment('0', '2026-12-01', 'off', False)]
        self.assertFeasible(solve(request(s)))
        confirm_months(s, '2026-12')
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)

    def test_weighted_last_week_includes_next_month_only_when_all_members_are_confirmed(self):
        prior = [assignment(eid, f'2026-09-{day}', locked=False)
                 for day in (28, 29, 30) for eid in ('a', 'b')]
        # One member's off record does not establish Sunday's team total.
        future_off = assignment('c', '2026-11-01', 'off', False)
        s = state(employees=[employee(eid, cap=168) for eid in ('a', 'b', 'c')],
                  shifts=[shift(required=2, mode='fixed')], assignments=prior + [future_off])
        confirm_months(s, '2026-09')
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertTrue(all(item in result['assignments'] for item in s['assignments']))
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        self.assertEqual(sum(item['shiftId'] != 'off' and '2026-10-26' <= item['date'] <= '2026-10-31'
                             for item in result['assignments']), 12)
        # Once November is confirmed, Sunday's zero starts must participate in
        # the same full natural week and conflict with the fixed count of two.
        confirm_months(s, '2026-11')
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)

    def test_zero_weight_partial_week_can_be_empty_only_when_daily_minimum_permits_it(self):
        locked = [assignment(str(i), '2026-02-02') for i in range(7)]
        s = state(month='2026-02', employees=[employee(str(i), cap=168) for i in range(7)],
                  shifts=[shift(required=0)], assignments=locked)
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertFalse(any(a['date'] == '2026-02-01' for a in result['assignments']))
        self.assertEqual(len(result['assignments']), 7)
        self.assert_weighted_actual(s, result['assignments'])
        s['shifts'][0]['required'] = 1
        result = solve(request(s))
        self.assertEqual(result['status'], 'INFEASIBLE')
        self.assertNotIn('assignments', result)

    def test_all_weekdays_at_100_percent_is_uniform(self):
        s = state(month='2026-06', employees=[employee('a', cap=168), employee('b', cap=168)])
        s['rules'].update(weekdayWeights={'days': list(range(1, 8)), 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 30)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])

    def test_weighted_zero_required_nights_can_supply_weekly_minimum(self):
        s = state(month='2026-06', employees=[employee(str(i), ['night'], cap=168, minimum_week=8) for i in range(7)], shifts=[shift('night', '23:00', '07:00', 0)])
        s['rules'].update(weekdayWeights={'days': [1], 'percent': 100}, minRestHours=0, maxConsecutiveDays=31)
        result = solve(request(s))
        self.assertFeasible(result)
        self.assertEqual(len(result['assignments']), 35)
        for eid in map(str, range(7)):
            self.assert_prorated_weekly_hours(s, result['assignments'], eid)
        self.assert_weighted_actual(s, result['assignments'])

    def test_twelve_employees_meet_weekly_minimum_and_maximum_hours(self):
        ids = ['early', 'late', 'night']
        s = state(employees=[employee(str(i), ids, cap=56, minimum_week=40) for i in range(12)],
                  shifts=[shift(), shift('late', '14:00', '22:00'), shift('night', '22:00', '06:00')])
        s['rules']['maxConsecutiveDays'] = 5
        # CI hosts vary; the product's 15-second budget is checked separately.
        r = request(s); r['options']['timeLimitSeconds'] = 30
        result = solve(r)
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assertGreater(len(result['assignments']), 31 * 3)
        self.assertLess(len(result['assignments']), 31 * 12)
        for employee_id in map(str, range(12)):
            self.assert_prorated_weekly_hours(s, result['assignments'], employee_id)

    def test_twelve_employee_minimums_also_work_with_uniform_hard_weekday_weights(self):
        ids = ['early', 'late', 'night']
        s = state(employees=[employee(str(i), ids, cap=56, minimum_week=40) for i in range(12)],
                  shifts=[shift(), shift('late', '14:00', '22:00'), shift('night', '22:00', '06:00')])
        s['rules'].update(maxConsecutiveDays=5, weekdayWeights={'days': list(range(1, 8)), 'percent': 100})
        r = request(s); r['options']['timeLimitSeconds'] = 30
        result = solve(r)
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        self.assert_weighted_actual(s, result['assignments'])
        for eid in map(str, range(12)):
            self.assert_prorated_weekly_hours(s, result['assignments'], eid)

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
        validation = subprocess.run(['node', str(folder / 'crosscheck.mjs')], input=json.dumps(dict(state=s, assignments=result['assignments'], boundaryPreview=result['boundaryPreview'], referenceDate='2030-01-01')), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    @unittest.skipUnless(shutil.which('node'), 'Node required for frontend request serialization')
    def test_frontend_request_omits_deprecated_monthly_fields_and_keeps_weekly_hours(self):
        folder = Path(__file__).resolve().parent
        fixture = subprocess.run(['node', str(folder / 'default_fixture.mjs'), '--reference'], text=True, encoding='utf-8', capture_output=True, check=True)
        s = json.loads(fixture.stdout)
        self.assertTrue(all('minHoursPerMonth' not in e for e in s['employees']))
        self.assertNotIn('monthlyReferenceHours', s)
        for e in s['employees']:
            e['minHoursPerWeek'] = 14
        r = request(s); r['options']['timeLimitSeconds'] = 10
        result = solve(r)
        self.assertFeasible(result)
        self.assert_daily_minimum(s, result['assignments'])
        for e in s['employees']:
            self.assert_prorated_weekly_hours(s, result['assignments'], e['id'])
        validation = subprocess.run(['node', str(folder / 'crosscheck.mjs')], input=json.dumps(dict(state=s, assignments=result['assignments'], boundaryPreview=result['boundaryPreview'], referenceDate='2030-01-01')), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])

    @unittest.skipUnless(shutil.which('node'), 'Node required for independent JS validation')
    def test_positive_weekly_minimums_with_legacy_month_fields_match_js_validator(self):
        s = state(employees=[employee('a', minimum_month=1000000, minimum_week=14), employee('b', minimum_month=None, minimum_week=14)])
        result = solve(request(s))
        self.assertFeasible(result)
        folder = Path(__file__).resolve().parent
        validation = subprocess.run(['node', str(folder / 'crosscheck.mjs')], input=json.dumps(dict(state=s, assignments=result['assignments'], boundaryPreview=result['boundaryPreview'], referenceDate='2030-01-01')), text=True, encoding='utf-8', capture_output=True, check=True)
        self.assertEqual(json.loads(validation.stdout), [])
        self.assertEqual(len(result['assignments']), 31)
        for eid in ('a', 'b'):
            self.assert_prorated_weekly_hours(s, result['assignments'], eid)

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
