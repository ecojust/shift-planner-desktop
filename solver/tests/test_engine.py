import copy
import json
from pathlib import Path
import subprocess
import shutil
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import solve


def employee(eid, eligible=None, cap=48, leave=None):
    return dict(id=eid, name=eid, role='', group='', color='#123456', maxHoursPerWeek=cap, eligibleShiftIds=eligible or ['early'], unavailableDates=leave or [])


def shift(sid='early', start='08:00', end='16:00', required=1):
    return dict(id=sid, name=sid, shortName=sid, color='#123456', start=start, end=end, required=required)


def state(employees=None, shifts=None, month='2026-10', assignments=None, **rules):
    return dict(version=1, teamName='测试', month=month, employees=employees or [employee('a'), employee('b')], shifts=shifts or [shift()], assignments=assignments or [], rules=dict(minRestHours=11, maxConsecutiveDays=6, balanceWeekends=True, separationGroups=[], **rules))


def request(s, **options):
    return dict(protocolVersion=1, requestId='test-1', state=s, options=dict(timeLimitSeconds=3, seed=1010, allowPartial=False, **options))


def assignment(eid, date, sid='early', locked=True):
    return dict(employeeId=eid, date=date, shiftId=sid, locked=locked)


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
