"""Bidirectional natural-week planning with explicit known/unknown history."""
import calendar
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve


def shift(sid='day', start='08:00', end='16:00', required=0):
    return dict(id=sid, name=sid, start=start, end=end, required=required, staffingMode='minimum')


def assignment(date, sid='day', locked=False, eid='a'):
    return dict(employeeId=eid, date=date, shiftId=sid, locked=locked)


def request(month='2026-11', minimum=40, maximum=40, shifts=None, assignments=None, reference='2026-11-01', coverage=None):
    shifts = shifts or [shift()]
    return dict(protocolVersion=1, requestId='boundary-week-test',
                state=dict(version=1, month=month, teamName='跨月回归', shifts=shifts,
                           employees=[dict(id='a', name='甲', minHoursPerWeek=minimum, maxHoursPerWeek=maximum,
                                           eligibleShiftIds=[item['id'] for item in shifts], unavailableDates=[])],
                           assignments=assignments or [], scheduleCoverage=coverage or {},
                           rules=dict(minRestHours=0, maxConsecutiveDays=31)),
                options=dict(timeLimitSeconds=3, seed=1010, allowPartial=False, referenceDate=reference))


def minutes_by_week(data, records):
    """Independent actual-minute oracle. No solver-derived requirements."""
    shifts = {item['id']: item for item in data['state']['shifts']}
    total = {}
    for record in records:
        if record['shiftId'] == 'off':
            continue
        item = shifts[record['shiftId']]
        cursor = dt.datetime.fromisoformat(record['date'] + 'T' + item['start'])
        end = dt.datetime.fromisoformat(record['date'] + 'T' + item['end'])
        if end <= cursor:
            end += dt.timedelta(days=1)
        while cursor < end:
            boundary = min(end, dt.datetime.combine(cursor.date() + dt.timedelta(days=1), dt.time()))
            week = (cursor.date() - dt.timedelta(days=cursor.weekday())).isoformat()
            key = record['employeeId'], week
            total[key] = total.get(key, 0) + int((boundary - cursor).total_seconds() // 60)
            cursor = boundary
    return total


class WeeklyBoundaryTest(unittest.TestCase):
    def feasible(self, data):
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertIn(result['status'], ('OPTIMAL', 'FEASIBLE'), result)
        self.assertEqual(data, original)
        month = data['state']['month']
        first = dt.date.fromisoformat(month + '-01')
        last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
        start = first - dt.timedelta(days=first.weekday())
        end = last + dt.timedelta(days=6 - last.weekday())
        reference = dt.date.fromisoformat(data['options']['referenceDate'])
        existing = {(a['employeeId'], a['date']) for a in data['state']['assignments'] if not a['date'].startswith(month)}
        original_outside = [a for a in original['state']['assignments'] if not a['date'].startswith(month)]
        self.assertEqual(sorted([a for a in result['assignments'] if not a['date'].startswith(month)], key=str), sorted(original_outside, key=str))
        for a in result['boundaryPreview']:
            day = dt.date.fromisoformat(a['date'])
            self.assertTrue(start <= day <= end and day >= reference and not a['date'].startswith(month))
            self.assertNotIn((a['employeeId'], a['date']), existing)
            self.assertNotIn(a['employeeId'], data['state']['scheduleCoverage'].get(a['date'][:7], {}).get('employeeIds', []))
            self.assertFalse(a['locked'])
        totals = minutes_by_week(data, result['assignments'] + result['boundaryPreview'])
        for employee in data['state']['employees']:
            eid = employee['id']
            week = start
            while week <= end:
                known_days = 0
                for offset in range(7):
                    day = week + dt.timedelta(days=offset)
                    key = day.isoformat()
                    if (key.startswith(month) or day >= reference or (eid, key) in existing or
                        eid in data['state']['scheduleCoverage'].get(key[:7], {}).get('employeeIds', [])):
                        known_days += 1
                minimum = (round(employee['minHoursPerWeek'] * 60) * known_days + 6) // 7
                self.assertGreaterEqual(totals.get((eid, week.isoformat()), 0), minimum, result)
                self.assertLessEqual(totals.get((eid, week.isoformat()), 0), employee['maxHoursPerWeek'] * 60, result)
                week += dt.timedelta(days=7)
        return result

    def infeasible(self, data, kind=None):
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        self.assertNotIn('boundaryPreview', result)
        self.assertEqual(data, original)
        if kind:
            self.assertTrue(any(i['type'] == kind for i in result['issues']), result)
        return result

    def test_both_unknown_future_boundaries_are_planned_as_full_weeks(self):
        result = self.feasible(request(reference='2026-10-01'))
        self.assertTrue(any(a['date'] < '2026-11-01' for a in result['boundaryPreview']))
        self.assertTrue(any(a['date'] > '2026-11-30' for a in result['boundaryPreview']))
        self.assertEqual(result['boundaryContext']['incompleteHistory'], [])
        self.assertFalse(any(i['type'] == 'history-incomplete' for i in result['issues']))

    def test_unknown_past_is_never_filled_or_silently_treated_as_off(self):
        result = self.feasible(request())
        self.assertFalse(any(a['date'] < '2026-11-01' for a in result['boundaryPreview']))
        self.assertEqual(result['boundaryContext']['incompleteHistory'], [dict(employeeId='a', weekStart='2026-10-26', unknownDates=[f'2026-10-{d}' for d in range(26, 32)])])
        self.assertTrue(any(i['type'] == 'history-incomplete' and i['severity'] == 'warning' for i in result['issues']))
        self.assertTrue(any(a['date'] == '2026-11-01' for a in result['assignments']))

    def test_sparse_prior_record_is_not_whole_month_confirmation(self):
        data = request(assignments=[assignment('2026-10-26')])
        result = self.feasible(data)
        self.assertEqual(len(result['boundaryContext']['incompleteHistory'][0]['unknownDates']), 5)
        data['state']['scheduleCoverage'] = {'2026-10': {'employeeIds': ['a']}}
        self.infeasible(data, 'weekly-min-hours')

    def test_old_remote_records_do_not_confirm_recent_history(self):
        result = self.feasible(request(assignments=[assignment('2026-08-01', 'off')]))
        self.assertEqual(len(result['boundaryContext']['incompleteHistory'][0]['unknownDates']), 6)

    def test_confirmed_previous_month_forty_hours_fulfills_first_sunday(self):
        for locked in (False, True):
            data = request(assignments=[assignment(f'2026-10-{day}', locked=locked) for day in range(26, 31)], coverage={'2026-10': {'employeeIds': ['a']}})
            result = self.feasible(data)
            self.assertFalse(any(a['date'] == '2026-11-01' for a in result['assignments']))
            self.assertEqual(result['boundaryContext']['incompleteHistory'], [])

    def test_confirmed_blank_is_fixed_rest_even_when_date_is_future(self):
        data = request(reference='2026-10-01', coverage={'2026-10': {'employeeIds': ['a']}})
        self.infeasible(data, 'weekly-min-hours')

    def test_explicit_daily_off_records_can_confirm_a_week_without_metadata(self):
        records = [assignment(f'2026-10-{day}') for day in range(26, 31)] + [assignment('2026-10-31', 'off')]
        result = self.feasible(request(assignments=records))
        self.assertFalse(result['boundaryContext']['incompleteHistory'])
        self.assertFalse(any(a['date'] == '2026-11-01' for a in result['assignments']))

    def test_future_confirmed_week_deficit_must_be_met_in_current_month(self):
        data = request(assignments=[assignment(f'2026-12-{day:02}') for day in range(1, 5)], coverage={'2026-12': {'employeeIds': ['a']}})
        result = self.feasible(data)
        self.assertTrue(any(a['date'] == '2026-11-30' for a in result['assignments']))
        self.assertFalse(result['boundaryPreview'])
        data['state']['assignments'].append(assignment('2026-11-30', 'off', True))
        self.infeasible(data, 'weekly-min-hours')

    def test_future_confirmed_rest_must_still_meet_daily_staffing(self):
        data = request(minimum=0, maximum=168, shifts=[shift(required=1)],
                       coverage={'2026-12': {'employeeIds': ['a']}})
        result = self.infeasible(data, 'coverage-capacity')
        issue = next(i for i in result['issues'] if i['type'] == 'coverage-capacity')
        self.assertEqual(issue['date'], '2026-12-01')
        self.assertIn('相邻月份已确认休息', issue['message'])
        self.assertIn('已有确认安排保持不变', issue['message'])

    def test_future_confirmed_forty_hours_avoid_double_minimum(self):
        result = self.feasible(request(assignments=[assignment(f'2026-12-{day:02}') for day in range(1, 6)], coverage={'2026-12': {'employeeIds': ['a']}}))
        self.assertFalse(any(a['date'] == '2026-11-30' for a in result['assignments']))
        self.assertFalse(result['boundaryPreview'])

    def test_outgoing_night_minutes_count_in_the_same_full_boundary_week(self):
        records = [assignment(f'2026-10-{day}', 'night') for day in range(26, 31)]
        records += [assignment(f'2026-12-{day:02}', 'night') for day in range(1, 5)]
        data = request(shifts=[shift('night', '22:00', '06:00')], assignments=records,
                       coverage={'2026-10': {'employeeIds': ['a']}, '2026-12': {'employeeIds': ['a']}})
        result = self.feasible(data)
        self.assertTrue(any(a['date'] == '2026-11-30' for a in result['assignments']))
        self.assertEqual(minutes_by_week(data, result['assignments'])[('a', '2026-11-30')], 40 * 60)

    def test_carry_in_tail_is_counted_once_and_full_week_minimum_is_met(self):
        records = [assignment(f'2026-10-{day}', 'seven') for day in range(26, 31)] + [assignment('2026-10-31', 'carry')]
        data = request(shifts=[shift(), shift('seven', end='15:00'), shift('carry', '23:00', '01:00'), shift('three', '02:00', '05:00')], assignments=records,
                       coverage={'2026-10': {'employeeIds': ['a']}})
        result = self.feasible(data)
        self.assertEqual([a['shiftId'] for a in result['assignments'] if a['date'] == '2026-11-01'], ['three'])
        self.assertEqual(minutes_by_week(data, result['assignments'])[('a', '2026-10-26')], 40 * 60)

    def test_unknown_historical_suffix_is_prorated_and_warned(self):
        result = self.feasible(request(reference='2027-01-01'))
        self.assertEqual(len(result['boundaryContext']['incompleteHistory']), 2)
        self.assertFalse(result['boundaryPreview'])
        self.assertTrue(any(a['date'] == '2026-11-30' for a in result['assignments']))

    def test_confirmations_are_per_person_not_shared_by_all_employees(self):
        data = request(minimum=8, maximum=40, coverage={'2026-10': {'employeeIds': ['a']}})
        data['state']['employees'].append(dict(data['state']['employees'][0], id='b', name='乙'))
        result = self.feasible(data)
        self.assertEqual([i['employeeId'] for i in result['boundaryContext']['incompleteHistory']], ['b'])

    def test_fixed_full_week_upper_limit_stays_hard(self):
        self.infeasible(request(assignments=[assignment(f'2026-10-{day}') for day in range(26, 32)]), 'weekly-hours')

    def test_future_preview_obeys_daily_coverage_and_weekly_shift_counts(self):
        data = request(minimum=0, maximum=48, shifts=[shift(required=1)], reference='2026-10-01')
        data['state']['employees'].append(dict(data['state']['employees'][0], id='b', name='乙'))
        data['state']['rules']['weeklyShiftLimits'] = [{'id': 'limit', 'shiftId': 'day', 'maxPerWeek': 4}]
        result = self.feasible(data)
        self.assertEqual(len(result['boundaryPreview']), 12)
        counts = {}
        for a in result['assignments'] + result['boundaryPreview']:
            day = dt.date.fromisoformat(a['date'])
            key = a['employeeId'], day - dt.timedelta(days=day.weekday())
            counts[key] = counts.get(key, 0) + 1
        self.assertTrue(all(count <= 4 for count in counts.values()))

    def test_future_preview_respects_leave_and_separation(self):
        data = request(minimum=0, maximum=168, shifts=[shift(required=1)], reference='2026-10-01')
        data['state']['employees'].append(dict(data['state']['employees'][0], id='b', name='乙'))
        data['state']['employees'][0]['unavailableDates'] = ['2026-12-01']
        data['state']['rules']['separationGroups'] = [{'id': 'g', 'name': '组', 'employeeIds': ['a', 'b'], 'shiftIds': []}]
        result = self.feasible(data)
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] == '2026-12-01' for a in result['boundaryPreview']))
        self.assertEqual(len(result['boundaryPreview']), 12)

    def test_future_preview_weekday_weights_use_all_seven_real_counts(self):
        data = request(minimum=0, maximum=168, shifts=[shift(required=1)], reference='2026-10-01')
        data['state']['employees'] += [dict(data['state']['employees'][0], id=eid, name=eid) for eid in ('b', 'c')]
        data['state']['rules']['weekdayWeights'] = {'days': [6, 7], 'percent': 50}
        result = self.feasible(data)
        daily = {}
        for a in result['assignments'] + result['boundaryPreview']:
            daily[a['date']] = daily.get(a['date'], 0) + 1
        start = dt.date(2026, 10, 26)
        for offset in range(0, 42, 7):
            counts = [daily.get((start + dt.timedelta(days=offset + day)).isoformat(), 0) for day in range(7)]
            self.assertGreaterEqual(min(counts), 1)
            self.assertEqual(sum(counts[5:]), (sum(counts) * 50 + 99) // 100)
            self.assertLessEqual(max(counts[:5]) - min(counts[:5]), 1)
            self.assertLessEqual(abs(counts[5] - counts[6]), 1)

    def test_preview_sunday_overnight_tail_respects_next_known_week_cap(self):
        data = request(minimum=0, maximum=40, shifts=[shift('night', '22:00', '06:00', 1)],
                       assignments=[assignment(f'2026-12-{day:02}', 'night') for day in range(7, 12)], reference='2026-10-01')
        data['state']['employees'].append(dict(data['state']['employees'][0], id='b', name='乙', maxHoursPerWeek=168))
        result = self.feasible(data)
        self.assertFalse(any(a['employeeId'] == 'a' and a['date'] == '2026-12-06' for a in result['boundaryPreview']))
        self.assertLessEqual(minutes_by_week(data, result['assignments'] + result['boundaryPreview'])[('a', '2026-12-07')], 40 * 60)

    def test_fixed_boundary_sunday_overnight_tail_checks_next_week_cap(self):
        data = request(month='2026-05', minimum=0, maximum=40, shifts=[shift('night', '22:00', '06:00')],
                       assignments=[assignment('2026-05-31', 'night', True), *[assignment(f'2026-06-{day:02}', 'night') for day in range(1, 6)]], reference='2026-05-01')
        self.infeasible(data, 'weekly-hours')

    def test_unrelated_remote_fixed_errors_are_preserved_without_blocking(self):
        records = [assignment('2025-01-01'), assignment('2025-01-01'), assignment('2025-01-02')]
        result = self.feasible(request(assignments=records))
        self.assertEqual(sum(a['date'] == '2025-01-01' for a in result['assignments']), 2)

    def test_partial_coverage_prioritizes_target_month_over_temporary_days(self):
        data = request(month='2026-10', minimum=0, maximum=168, shifts=[shift(required=1)], reference='2026-10-01')
        data['state']['rules']['nonConsecutiveShifts'] = [{'id': 'every-other', 'shiftId': 'day'}]
        data['options']['allowPartial'] = True
        result = self.feasible(data)
        # Alternating work can cover at most 16 of October's 31 days. Optimizing
        # an undifferentiated whole horizon used to trade away a target day.
        self.assertEqual(len(result['assignments']), 16)
        self.assertEqual(result['stats']['shortageCount'], 15)
        self.assertTrue(any(i['type'] == 'boundary-coverage' for i in result['issues']))
        self.assertFalse(any(a['date'].startswith('2026-11') for a in result['assignments']))

    def test_reference_date_and_coverage_are_strictly_validated(self):
        for bad in (None, 20261101, '2026-11-1', '2026-02-30'):
            data = request()
            data['options']['referenceDate'] = bad
            self.assertEqual(solve(data)['status'], 'MODEL_INVALID')
        for bad in (None, [], {'2026-11': {}}, {'2026-11': {'employeeIds': ['missing']}}, {'2026-11': {'employeeIds': ['a', 'a']}}, {'2026-13': {'employeeIds': ['a']}}):
            data = request()
            data['state']['scheduleCoverage'] = bad
            self.assertEqual(solve(data)['status'], 'MODEL_INVALID')

    def test_legacy_monthly_minimum_does_not_change_full_week_requirements(self):
        data = request(reference='2026-10-01')
        data['state']['employees'][0]['minHoursPerMonth'] = 1000000
        self.feasible(data)


if __name__ == '__main__':
    unittest.main()
