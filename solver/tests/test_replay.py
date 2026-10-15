"""The downloadable JSON runs unchanged in the native solver's file interface."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / 'solver' / 'main.py'
spec = importlib.util.spec_from_file_location('replay_entry', ENTRY)
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class NeverReadStdin:
    @property
    def buffer(self):
        raise AssertionError('file replay must not read stdin')


class ReplayTests(unittest.TestCase):
    def test_file_mode_does_not_wait_for_stdin_and_keeps_hosted_stages(self):
        request = {'protocolVersion': 1, 'requestId': 'file-request'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '规则 with spaces.json'
            path.write_text(json.dumps(request), encoding='utf-8')
            output, diagnostics = io.StringIO(), io.StringIO()
            with patch.object(entry.sys, 'argv', ['main.py', '--hosted', '--input', str(path)]), \
                    patch.object(entry.sys, 'stdin', NeverReadStdin()), \
                    patch.object(entry, 'load_engine', return_value=lambda value, **_: value), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
                entry.main()
        self.assertEqual(json.loads(output.getvalue()), request)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(diagnostics.getvalue().splitlines(), [
            'SHIFTFLOW_STAGE_V1:loading', 'SHIFTFLOW_STAGE_V1:reading',
            'SHIFTFLOW_STAGE_V1:solving', 'SHIFTFLOW_STAGE_V1:finishing',
        ])

    def test_bad_file_inputs_return_one_json_result_without_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.json'
            cases = [
                (['--input'], None, '文件路径'),
                (['--input', '--hosted'], None, '文件路径'),
                (['--input', str(path), '--input', str(path)], None, '只能指定一个'),
                (['--input', str(path)], None, '无法读取'),
                (['--input', str(path)], b'{broken', 'Expecting'),
                (['--input', str(path)], b'{"state": NaN}', '非有限数字'),
                (['--input', str(path)], b'x' * (8 * 1024 * 1024 + 1), '8 MiB'),
            ]
            for arguments, contents, message in cases:
                with self.subTest(arguments=arguments, message=message):
                    if contents is not None:
                        path.write_bytes(contents)
                    output = io.StringIO()
                    with patch.object(entry.sys, 'argv', ['main.py', *arguments]), \
                            patch.object(entry.sys, 'stdin', NeverReadStdin()), \
                            patch.object(entry, 'load_engine', return_value=lambda _: self.fail('invalid input reached solve')), \
                            contextlib.redirect_stdout(output):
                        entry.main()
                    result = json.loads(output.getvalue())
                    self.assertEqual(result['status'], 'MODEL_INVALID')
                    self.assertNotIn('assignments', result)
                    self.assertIn(message, result['issues'][0]['message'])
                    self.assertNotIn(directory, output.getvalue())
                    self.assertEqual(len(output.getvalue().splitlines()), 1)

    def test_stdin_protocol_remains_available_and_has_the_same_size_limit(self):
        for contents, expected in [(b'{"protocolVersion":1}', {'protocolVersion': 1}), (b'x' * (8 * 1024 * 1024 + 1), None)]:
            source = io.TextIOWrapper(io.BytesIO(contents), encoding='utf-8')
            with patch.object(entry.sys, 'argv', ['main.py']), patch.object(entry.sys, 'stdin', source):
                if expected is not None:
                    self.assertEqual(entry.read_request(), expected)
                else:
                    with self.assertRaisesRegex(ValueError, '8 MiB'):
                        entry.read_request()

    def test_legacy_month_minimum_values_do_not_constrain_file_replay(self):
        for legacy_minimum in (None, 744):
            with self.subTest(minHoursPerMonth=legacy_minimum), tempfile.TemporaryDirectory() as directory:
                request = {
                    'protocolVersion': 1, 'requestId': 'legacy-file-replay',
                    'state': {
                        'version': 1, 'month': '2026-10', 'teamName': '旧规则文件',
                        'monthlyReferenceHours': {'2026-10': 744},
                        'employees': [{'id': 'a', 'name': '甲', 'minHoursPerMonth': legacy_minimum,
                                       'minHoursPerWeek': 0, 'maxHoursPerWeek': 168,
                                       'eligibleShiftIds': ['early'], 'unavailableDates': []}],
                        'shifts': [{'id': 'early', 'name': '早班', 'start': '08:00', 'end': '16:00',
                                    'required': 0, 'staffingMode': 'minimum'}],
                        'rules': {'minRestHours': 0, 'maxConsecutiveDays': 31}, 'assignments': [],
                    },
                    'options': {'timeLimitSeconds': 3, 'allowPartial': False, 'seed': 1010},
                    'debug': {'format': 'shiftflow-solver-debug', 'formatVersion': 1,
                              'originalHourDefaults': [{'employeeId': 'a', 'minHoursPerMonth': legacy_minimum,
                                                        'minHoursPerWeek': 0}]},
                }
                exported = json.dumps(request, ensure_ascii=False)
                path = Path(directory) / '旧排班规则.json'
                path.write_text(exported, encoding='utf-8')
                output = subprocess.run([sys.executable, str(ENTRY), '--input', str(path)],
                                        cwd=ROOT, capture_output=True, text=True, timeout=20, check=True)
                result = json.loads(output.stdout)
                self.assertEqual(result['status'], 'OPTIMAL', result)
                self.assertEqual(result['requestId'], 'legacy-file-replay')
                self.assertEqual(result['assignments'], [])
                self.assertEqual(output.stderr, '')
                self.assertEqual(path.read_text(encoding='utf-8'), exported)

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for the TypeScript export integration')
    def test_browser_generated_json_replays_unchanged_through_the_real_engine(self):
        state = {
            'version': 1, 'teamName': '复现测试', 'month': '2026-10',
            'monthlyReferenceHours': {'2026-10': 24},
            'employees': [{'id': 'a', 'name': '小林', 'role': '', 'group': '', 'color': '#123456',
                           'minHoursPerMonth': None, 'minHoursPerWeek': 0, 'maxHoursPerWeek': 168,
                           'eligibleShiftIds': ['early'], 'unavailableDates': ['2026-10-03']}],
            'shifts': [{'id': 'early', 'name': '早班', 'shortName': '早', 'start': '08:00', 'end': '16:00',
                        'color': '#123456', 'required': 0, 'staffingMode': 'minimum'}],
            'rules': {'minRestHours': 0, 'maxConsecutiveDays': 31},
            'assignments': [{'employeeId': 'a', 'date': '2026-09-30', 'shiftId': 'early', 'locked': False},
                            {'employeeId': 'a', 'date': '2026-10-02', 'shiftId': 'off', 'locked': True}],
        }
        script = """
import { createSolverRequest, solverDebugJSON } from './src/solverDebug.ts';
const state = JSON.parse(process.argv[1]);
const request = createSolverRequest(state, { timeLimitSeconds: 3, allowPartial: false, seed: 1010 }, 'real-file-replay');
process.stdout.write(solverDebugJSON(request, { source: 'attempt', originalState: state }));
"""
        exported = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script, json.dumps(state)],
                                  cwd=ROOT, capture_output=True, text=True, timeout=20, check=True).stdout
        parsed = json.loads(exported)
        self.assertNotIn('monthlyReferenceHours', parsed['state'])
        self.assertNotIn('minHoursPerMonth', parsed['state']['employees'][0])
        self.assertEqual(parsed['debug']['originalHourDefaults'], [{'employeeId': 'a', 'minHoursPerWeek': 0}])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '排班规则.json'
            path.write_text(exported, encoding='utf-8')
            output = subprocess.run([sys.executable, str(ENTRY), '--input', str(path)],
                                    cwd=ROOT, capture_output=True, text=True, timeout=20, check=True)
            self.assertEqual(output.stderr, '')
            self.assertEqual(path.read_text(encoding='utf-8'), exported, 'replay must not edit the exported rules')
            result = json.loads(output.stdout)
        self.assertIn(result['status'], ['FEASIBLE', 'OPTIMAL'], result)
        self.assertEqual(result['requestId'], 'real-file-replay')
        for assignment in state['assignments']:
            self.assertIn(assignment, result['assignments'])
        shifts_in_month = [item for item in result['assignments'] if item['date'].startswith('2026-10') and item['shiftId'] != 'off']
        self.assertEqual(shifts_in_month, [], 'legacy monthly defaults must not add work to a zero-minimum roster')


if __name__ == '__main__':
    unittest.main()
