"""Conflict explanations must be factual, actionable and preserve solver outcomes."""
import copy
import datetime as dt
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve
from diagnostics import ConstraintDiagnostics, problem
from ortools.sat.python import cp_model
from test_engine import assignment, employee, request, shift, state


class DiagnosticsTest(unittest.TestCase):
    def assert_failure(self, result, kind):
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        self.assertNotIn('assignments', result)
        issues = [i for i in result['issues'] if i['type'] == kind]
        self.assertTrue(issues, result)
        for issue in issues:
            self.assertTrue(issue.get('suggestion'), issue)
            self.assertIn(issue.get('target'), ('team', 'shifts', 'rules', 'calendar'))
        return issues

    def test_daily_missing_employee_names_date_and_counts(self):
        s = state(employees=[employee('甲', leave=['2026-10-01']), employee('乙', ['night'])], shifts=[shift(), shift('night', '22:00', '06:00', 0)])
        result = solve(request(s))
        items = self.assert_failure(result, 'coverage-capacity')
        self.assertEqual(items[0]['date'], '2026-10-01')
        self.assertEqual(items[0]['shiftId'], 'early')
        self.assertIn('最多 0 人', items[0]['message'])
        self.assertIn('甲', items[0]['message'])
        self.assertIn('请假', items[0]['message'])
        self.assertIn('乙', items[0]['message'])
        self.assertIn('未勾选', items[0]['message'])
        s['employees'][0]['unavailableDates'] = []
        s['employees'][1]['eligibleShiftIds'].append('early')
        self.assertIn(solve(request(s))['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_daily_shared_candidates_identifies_competing_shifts(self):
        s = state(employees=[employee('甲', ['early', 'late']), employee('乙', ['night'])],
                  shifts=[shift(), shift('late', '14:00', '22:00'), shift('night', '22:00', '06:00', 0)])
        items = self.assert_failure(solve(request(s)), 'daily-shared-capacity')
        self.assertIn('early、late', items[0]['message'])
        self.assertIn('2 个班次名额', items[0]['message'])
        self.assertIn('仅 1 人（甲）', items[0]['message'])

    def test_separation_capacity_has_group_and_quantities(self):
        s = state(shifts=[shift(required=2)])
        s['rules']['separationGroups'] = [dict(id='g', name='师徒不可同班', employeeIds=['a', 'b'], shiftIds=[])]
        items = self.assert_failure(solve(request(s)), 'separation-capacity')
        self.assertIn('师徒不可同班', items[0]['message'])
        self.assertIn('最多可安排 1 人', items[0]['message'])
        r = request(s)
        r['options']['allowPartial'] = True
        self.assertIn(solve(r)['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_fixed_rest_has_both_shifts_gap_and_rule(self):
        s = state(employees=[employee('甲', ['early', 'late'])], shifts=[shift(), shift('late', '14:00', '22:00', 0)],
                  assignments=[assignment('甲', '2026-10-01', 'late'), assignment('甲', '2026-10-02')])
        items = self.assert_failure(solve(request(s)), 'rest')
        self.assertIn('甲', items[0]['message'])
        self.assertIn('2026-10-01 late', items[0]['message'])
        self.assertIn('2026-10-02 early', items[0]['message'])
        self.assertIn('仅 10 小时', items[0]['message'])
        self.assertIn('至少休息 11 小时', items[0]['message'])

    def test_week_minimum_reports_available_hours_after_leave(self):
        s = state(employees=[employee('甲', cap=40, minimum_week=24,
                                      leave=[f'2026-10-{day:02d}' for day in range(5, 11)])],
                  shifts=[shift(required=0)])
        items = self.assert_failure(solve(request(s)), 'weekly-min-hours')
        self.assertEqual(items[0]['date'], '2026-10-05')
        self.assertEqual(items[0]['employeeId'], '甲')
        self.assertIn('本月实际最低要求为 24 小时', items[0]['message'])
        self.assertIn('本月最多不超过 8 小时', items[0]['message'])
        self.assertIn('至少相差 16 小时', items[0]['message'])
        s['employees'][0]['unavailableDates'] = []
        self.assertIn(solve(request(s))['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_weekly_fixed_capacity_reports_real_hours(self):
        s = state(employees=[employee(x, cap=40, minimum_week=24) for x in ['甲', '乙', '丙']], shifts=[shift(mode='fixed')])
        items = self.assert_failure(solve(request(s)), 'weekly-fixed-capacity')
        self.assertIn('最多提供 32 小时', items[0]['message'])
        self.assertIn('2026-09-28', items[0]['message'])
        self.assertEqual(items[0]['date'], '2026-10-01')

    def test_model_core_handles_whole_shifts_at_partial_week(self):
        # Arithmetic minimum fits (3 * ceil(16h * 4/7) < 32h), but each
        # employee needs two indivisible 8-hour shifts, exceeding four slots.
        s = state(employees=[employee(x, cap=40, minimum_week=16) for x in ['甲', '乙', '丙']], shifts=[shift(mode='fixed')])
        s['rules']['maxConsecutiveDays'] = 5
        original = copy.deepcopy(s)
        result = solve(request(s))
        self.assert_failure(result, 'constraint-combination')
        self.assertTrue(any(i['type'] == 'weekly-min-hours' and i.get('employeeId') for i in result['issues']))
        self.assertTrue(any(i['type'] == 'coverage' and i.get('date') for i in result['issues']))
        self.assertEqual(s, original)
        for e in s['employees']:
            e['minHoursPerWeek'] = 14
        r = request(s)
        r['options']['timeLimitSeconds'] = 6
        self.assertIn(solve(r)['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_model_core_states_background_rest_and_feasible_boundary(self):
        s = state(employees=[employee(x, ['early', 'night'], cap=168) for x in ['甲', '乙']],
                  shifts=[shift(mode='fixed'), shift('night', '22:00', '06:00', 1, 'fixed')])
        s['rules'].update(minRestHours=17, maxConsecutiveDays=31)
        result = solve(request(s))
        intro = self.assert_failure(result, 'constraint-combination')
        self.assertIn('最短休息 17 小时', intro[0]['message'])
        self.assertTrue(any(i['type'] == 'coverage' and i.get('shiftId') for i in result['issues']))
        s['rules']['minRestHours'] = 16
        self.assertIn(solve(request(s))['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_weekday_quota_reports_dates_and_feasible_variant(self):
        s = state(employees=[employee(x, cap=168) for x in ['甲', '乙']], shifts=[shift(mode='fixed')])
        s['rules'].update(minRestHours=0, maxConsecutiveDays=31, weekdayWeights={'days': [1, 2], 'percent': 50})
        items = self.assert_failure(solve(request(s)), 'weekday-weight-capacity')
        self.assertIn('星期 1、2 合计 50%', items[0]['message'])
        self.assertIn('10-', items[0]['message'])
        s['rules']['weekdayWeights']['percent'] = 25
        self.assertIn(solve(request(s))['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_overnight_carry_is_not_lost_in_weekly_upper_bound(self):
        s = state(month='2026-06', employees=[employee('甲', ['night'], cap=168, minimum_week=7)],
                  shifts=[shift('night', '23:00', '07:00', 1, 'fixed')],
                  assignments=[assignment('甲', '2026-05-31', 'night', False)])
        for d in range(1, 31):
            date = dt.date(2026, 6, d)
            if date.weekday() != 6:
                s['assignments'].append(assignment('甲', date.isoformat(), 'off'))
        r = request(s)
        r['options']['allowPartial'] = True
        self.assertIn(solve(r)['status'], ('OPTIMAL', 'FEASIBLE'))

    def test_diagnostic_error_preserves_proved_infeasible(self):
        s = state(employees=[employee(x, ['early', 'night'], cap=168) for x in ['甲', '乙']],
                  shifts=[shift(mode='fixed'), shift('night', '22:00', '06:00', 1, 'fixed')])
        s['rules'].update(minRestHours=17, maxConsecutiveDays=31)
        with patch('engine.ConstraintDiagnostics.explain', side_effect=RuntimeError('diagnosis failed')):
            result = solve(request(s))
        self.assert_failure(result, 'diagnosis-incomplete')
        self.assertNotIn('diagnosis failed', json_text(result))

    def test_large_core_is_bounded_and_subset_is_explicit(self):
        model = cp_model.CpModel()
        diagnostics = ConstraintDiagnostics()
        variables = [model.new_bool_var(f'x{i}') for i in range(101)]
        # Every one of the 101 assumptions is needed for this contradiction.
        model.add(sum(variables) <= 100)
        for i, var in enumerate(variables):
            diagnostics.track(model.add(var == 1), str(i), problem('coverage', f'名额 {i} 必须有人。', '核对名额。', 'shifts'))
        issues = diagnostics.explain(model, time.monotonic() + 3, 1010, '11')
        self.assertEqual(len(issues), 101)
        self.assertIn('共有 101 项', issues[0]['message'])
        self.assertIn('仅展示前 100 项', issues[0]['message'])
        self.assertIn('不是完整组合', issues[0]['message'])

    def test_exhausted_explanation_budget_is_explicit(self):
        diagnostics = ConstraintDiagnostics()
        issues = diagnostics.explain(cp_model.CpModel(), time.monotonic() - 1, 1010, '11')
        self.assertEqual(issues[0]['type'], 'diagnosis-incomplete')
        self.assertIn('已证明无解', issues[0]['message'])
        self.assertIn('时限不足', issues[0]['message'])


def json_text(value):
    import json
    return json.dumps(value, ensure_ascii=False)


if __name__ == '__main__':
    unittest.main()
