"""Known first natural weeks are completed without rewriting prior-month work."""
import calendar
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve


def shift(sid='day', start='08:00', end='16:00'):
    return dict(id=sid, name=sid, start=start, end=end, required=0, staffingMode='minimum')


def assignment(date, sid='day', locked=False):
    return dict(employeeId='a', date=date, shiftId=sid, locked=locked)


def request(month='2026-11', minimum=40, maximum=40, shifts=None, assignments=None, monthly=0):
    shifts = shifts or [shift()]
    return dict(protocolVersion=1, requestId='boundary-week-test',
                state=dict(version=1, month=month, teamName='跨月回归', shifts=shifts,
                           employees=[dict(id='a', name='甲', minHoursPerWeek=minimum, maxHoursPerWeek=maximum,
                                           minHoursPerMonth=monthly, eligibleShiftIds=[item['id'] for item in shifts], unavailableDates=[])],
                           assignments=assignments or [], rules=dict(minRestHours=0, maxConsecutiveDays=31)),
                options=dict(timeLimitSeconds=3, seed=1010, allowPartial=False))


def minutes_by_week(data, records):
    """Independent midnight-splitting oracle, including true month/week tails."""
    shifts = {item['id']: item for item in data['state']['shifts']}
    month = data['state']['month']
    total, inside = {}, {}
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
            minutes = int((boundary - cursor).total_seconds() // 60)
            total[week] = total.get(week, 0) + minutes
            if cursor.strftime('%Y-%m') == month:
                inside[week] = inside.get(week, 0) + minutes
            cursor = boundary
    return total, inside


class WeeklyBoundaryTest(unittest.TestCase):
    def assertFeasible(self, data):
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertIn(result['status'], ('OPTIMAL', 'FEASIBLE'), result)
        self.assertEqual(data, original)
        first = dt.date.fromisoformat(data['state']['month'] + '-01')
        days = [first + dt.timedelta(days=offset) for offset in range(calendar.monthrange(first.year, first.month)[1])]
        fixed = [record for record in original['state']['assignments'] if record['locked'] or not record['date'].startswith(first.strftime('%Y-%m'))]
        known_total, known_inside = minutes_by_week(data, fixed)
        actual_total, actual_inside = minutes_by_week(data, result['assignments'])
        employee = data['state']['employees'][0]
        full = int(employee['minHoursPerWeek'] * 60)
        previous_month = (first - dt.timedelta(days=1)).strftime('%Y-%m')
        employee_ids = {item['id'] for item in data['state']['employees']}
        known_previous_month = any(record['employeeId'] in employee_ids and record['date'].startswith(previous_month + '-')
                                   for record in original['state']['assignments'])
        for week in {day - dt.timedelta(days=day.weekday()) for day in days}:
            key = week.isoformat()
            count = sum(week <= day < week + dt.timedelta(days=7) for day in days)
            prorated = (full * count + 6) // 7
            outside = known_total.get(key, 0) - known_inside.get(key, 0)
            if week < first and known_previous_month:
                # Audit the finished natural week directly, independently of
                # the solver's formula for the editable month's residual.
                self.assertGreaterEqual(actual_total.get(key, 0), full, result)
            else:
                expected = min(prorated, max(0, full - outside))
                self.assertGreaterEqual(actual_inside.get(key, 0), expected, result)
            self.assertLessEqual(actual_total.get(key, 0), employee['maxHoursPerWeek'] * 60, result)
        self.assertTrue(all(record in result['assignments'] for record in fixed))
        return result

    def assertFailure(self, data, kind, week=None):
        original = copy.deepcopy(data)
        result = solve(data)
        self.assertEqual(data, original)
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        issues = [item for item in result['issues'] if item['type'] == kind and (week is None or week in item['message'])]
        self.assertTrue(issues, result)
        return issues

    def test_previous_month_40_hours_fulfills_november_first_sunday(self):
        for locked in (False, True):
            with self.subTest(locked=locked):
                data = request(assignments=[assignment(f'2026-10-{day}', locked=locked) for day in range(26, 31)])
                result = self.assertFeasible(data)
                self.assertFalse(any(item['date'] == '2026-11-01' for item in result['assignments']))

    def test_previous_month_35_hours_requires_only_five_more_hours(self):
        data = request(shifts=[shift(), shift('seven', end='15:00'), shift('five', end='13:00')],
                       assignments=[assignment(f'2026-10-{day}', 'seven') for day in range(26, 31)])
        result = self.assertFeasible(data)
        self.assertEqual([item['shiftId'] for item in result['assignments'] if item['date'] == '2026-11-01'], ['five'])

    def test_32_known_hours_plus_six_locked_hours_cannot_satisfy_full_40(self):
        data = request(shifts=[shift(), shift('six', end='14:00')],
                       assignments=[*[assignment(f'2026-10-{day}') for day in range(26, 30)],
                                    assignment('2026-11-01', 'six', True)])
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-10-26')
        message = issues[0]['message']
        self.assertIn('首自然周按完整周补足', message)
        self.assertIn('月外已排 32 小时', message)
        self.assertIn('本月实际最低要求为 8 小时', message)
        self.assertIn('本月最多不超过 6 小时', message)
        self.assertIn('至少相差 2 小时', message)

    def test_32_known_hours_requires_eight_hour_sunday(self):
        data = request(shifts=[shift(), shift('six', end='14:00')],
                       assignments=[assignment(f'2026-10-{day}') for day in range(26, 30)])
        result = self.assertFeasible(data)
        self.assertEqual([item['shiftId'] for item in result['assignments'] if item['date'] == '2026-11-01'], ['day'])

    def test_prior_month_off_far_from_first_week_makes_history_known(self):
        for locked in (False, True):
            with self.subTest(locked=locked):
                data = request(assignments=[assignment('2026-10-01', 'off', locked)])
                issues = self.assertFailure(data, 'weekly-min-hours', '2026-10-26')
                self.assertIn('月外已排 0 小时', issues[0]['message'])
                self.assertIn('本月实际最低要求为 40 小时', issues[0]['message'])

    def test_another_members_off_record_also_establishes_known_prior_month(self):
        data = request()
        data['state']['employees'].append(dict(data['state']['employees'][0], id='b', minHoursPerWeek=0))
        data['state']['assignments'] = [dict(assignment('2026-10-01', 'off'), employeeId='b')]
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-10-26')
        self.assertTrue(any(item['employeeId'] == 'a' and '本月实际最低要求为 40 小时' in item['message'] for item in issues))

    def test_cross_year_first_week_completes_december_hours(self):
        data = request(month='2027-01', shifts=[shift(), shift('six', end='14:00')],
                       assignments=[assignment('2026-12-28'), assignment('2026-12-29'),
                                    *[assignment(f'2027-01-{day:02d}', 'six', True) for day in range(1, 4)]])
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-12-28')
        self.assertIn('月外已排 16 小时', issues[0]['message'])
        self.assertIn('本月实际最低要求为 24 小时', issues[0]['message'])
        self.assertIn('本月最多不超过 18 小时', issues[0]['message'])

    def test_older_history_does_not_establish_previous_calendar_month(self):
        data = request(assignments=[assignment('2026-09-01', 'off')])
        self.assertFeasible(data)

    def test_minimum_36_maximum_44_and_40_known_hours_does_not_force_four_hour_gap(self):
        data = request(minimum=36, maximum=44, assignments=[assignment(f'2026-10-{day}') for day in range(26, 31)])
        result = self.assertFeasible(data)
        self.assertFalse(any(item['date'] == '2026-11-01' for item in result['assignments']))

    def test_minimum_44_with_40_known_hours_requires_exactly_four(self):
        data = request(minimum=44, maximum=44, shifts=[shift(), shift('four', end='12:00')],
                       assignments=[assignment(f'2026-10-{day}') for day in range(26, 31)])
        result = self.assertFeasible(data)
        self.assertEqual([item['shiftId'] for item in result['assignments'] if item['date'] == '2026-11-01'], ['four'])

    def test_two_day_month_boundary_does_not_require_prorated_hours_twice(self):
        data = request(month='2026-08', shifts=[shift(), shift('seven', end='15:00'), shift('five', end='13:00')],
                       assignments=[assignment(f'2026-07-{day}', 'seven') for day in range(27, 32)])
        result = self.assertFeasible(data)
        boundary = [item for item in result['assignments'] if item['date'] in ('2026-08-01', '2026-08-02')]
        self.assertEqual(len(boundary), 1)
        self.assertEqual(boundary[0]['shiftId'], 'five')

    def test_carry_in_inside_fragment_is_not_double_counted_as_outside_credit(self):
        data = request(shifts=[shift(), shift('seven', end='15:00'), shift('carry', '23:00', '01:00'), shift('three', '02:00', '05:00')],
                       assignments=[*[assignment(f'2026-10-{day}', 'seven') for day in range(26, 31)], assignment('2026-10-31', 'carry')])
        result = self.assertFeasible(data)
        total, inside = minutes_by_week(data, result['assignments'])
        self.assertEqual(total['2026-10-26'], 40 * 60)
        self.assertEqual(inside['2026-10-26'], 4 * 60)
        self.assertEqual([item['shiftId'] for item in result['assignments'] if item['date'] == '2026-11-01'], ['three'])

    def test_carry_in_failure_message_distinguishes_outside_and_inside_minutes(self):
        data = request(shifts=[shift(), shift('seven', end='15:00'), shift('carry', '23:00', '01:00')],
                       assignments=[*[assignment(f'2026-10-{day}', 'seven') for day in range(26, 31)], assignment('2026-10-31', 'carry'), assignment('2026-11-01', 'off', True)])
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-10-26')
        message = issues[0]['message']
        self.assertIn('原折算 5.72 小时', message)
        self.assertIn('月外已排 36 小时', message)
        self.assertIn('本月实际最低要求为 4 小时', message)
        self.assertIn('本月最多不超过 1 小时', message)
        self.assertIn('至少相差 3 小时', message)

    def test_following_month_known_assignments_also_reduce_boundary_target(self):
        for locked in (False, True):
            with self.subTest(locked=locked):
                data = request(assignments=[assignment(f'2026-12-{day:02d}', locked=locked) for day in range(1, 6)])
                result = self.assertFeasible(data)
                self.assertFalse(any(item['date'] == '2026-11-30' for item in result['assignments']))

    def test_unknown_candidate_outgoing_night_cannot_lower_the_target(self):
        records = [*[assignment(f'2026-10-{day}', 'night') for day in range(26, 30)],
                   assignment('2026-10-31', 'night'), assignment('2026-11-29', 'off', True),
                   *[assignment(f'2026-12-{day:02d}', 'night') for day in range(1, 5)]]
        data = request(shifts=[shift('night', '22:00', '06:00')], assignments=records)
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-11-30')
        self.assertIn('月外已排 32 小时', issues[0]['message'])
        self.assertIn('本月实际最低要求为 5.72 小时', issues[0]['message'])
        self.assertIn('本月最多不超过 2 小时', issues[0]['message'])
        # Once that current-month night is locked, its outside tail is known.
        data['state']['assignments'].append(assignment('2026-11-30', 'night', True))
        self.assertFeasible(data)

    def test_no_history_still_requires_the_original_partial_minimum(self):
        data = request()
        result = self.assertFeasible(data)
        self.assertTrue(any(item['date'] == '2026-11-01' for item in result['assignments']))
        data['state']['assignments'] = [assignment('2026-11-01', 'off', True)]
        issues = self.assertFailure(data, 'weekly-min-hours', '2026-10-26')
        self.assertIn('月外已排 0 小时', issues[0]['message'])
        self.assertIn('本月实际最低要求为 5.72 小时', issues[0]['message'])
        self.assertIn('未找到上月排班记录', issues[0]['message'])

    def test_true_full_week_upper_limit_violation_is_still_rejected(self):
        data = request(assignments=[assignment(f'2026-10-{day}') for day in range(26, 32)])
        issues = self.assertFailure(data, 'weekly-hours', '2026-10-26')
        self.assertIn('已有 48 小时', issues[0]['message'])
        self.assertIn('超过周上限 40 小时', issues[0]['message'])

    def test_month_minimum_cannot_be_satisfied_by_outside_credit(self):
        data = request(assignments=[assignment(f'2026-10-{day}') for day in range(26, 31)], monthly=8)
        data['state']['employees'][0]['unavailableDates'] = [f'2026-11-{day:02d}' for day in range(2, 31)]
        self.assertFailure(data, 'monthly-min-hours')

    def test_team_capacity_uses_individual_remaining_target(self):
        # Seven members each need an hour per full week. The old boundary
        # aggregate was 7 * ceil(60 / 7) = 63 minutes against 60 minutes of
        # daily capacity. Known outside hours remove that false contradiction.
        data = request(minimum=1, maximum=1, shifts=[shift(end='09:00')])
        template = data['state']['employees'][0]
        data['state']['employees'] = [dict(template, id=f'e{index}', name=f'成员{index}') for index in range(7)]
        data['state']['assignments'] = [dict(assignment('2026-10-26'), employeeId=f'e{index}') for index in range(7)]
        data['state']['assignments'] += [dict(assignment('2026-12-01'), employeeId=f'e{index}') for index in range(6)]
        data['state']['shifts'][0].update(staffingMode='fixed', required=1)
        data['options']['allowPartial'] = True
        result = solve(data)
        self.assertIn(result['status'], ('OPTIMAL', 'FEASIBLE'), result)
        self.assertFalse(any(item['date'] == '2026-11-01' for item in result['assignments']))


if __name__ == '__main__':
    unittest.main()
