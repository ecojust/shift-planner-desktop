"""Only distinct real scheduling solutions count; progress leaves stdout intact."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
from ortools.sat.python import cp_model
from test_engine import assignment, employee, request, shift, state

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / 'solver' / 'main.py'
PREFIX = 'SHIFTFLOW_SOLUTIONS_V1:'
spec = importlib.util.spec_from_file_location('solution_count_entry', ENTRY)
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


def unique_request(locked=False, partial=False):
    """All 31 days must be worked, with either fixed cells or real x variables."""
    fixed = [assignment('only', f'2026-10-{day:02}') for day in range(1, 32)] if locked else []
    data = request(state(
        employees=[employee('only', cap=168, minimum_month=0 if locked else 248)],
        shifts=[shift(mode='fixed')], assignments=fixed,
    ))
    data['state']['rules'].update(minRestHours=0, maxConsecutiveDays=31)
    data['options']['allowPartial'] = partial
    return data


class FlushRecorder(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flushed_values = []

    def flush(self):
        self.flushed_values.append(self.getvalue())
        super().flush()


class SolutionCountTests(unittest.TestCase):
    def assert_count(self, result, expected=None):
        count = result['stats']['solutionCount']
        self.assertIs(type(count), int, result)
        self.assertGreaterEqual(count, 0)
        if expected is not None:
            self.assertEqual(count, expected, result)
        return count

    def run_streamed(self, arguments, contents=b''):
        """Consume each stderr line while the child runs, never via communicate()."""
        chunks = {'stdout': [], 'stderr': []}
        output_lines = queue.Queue()
        live_counts = []

        def read_lines(name, stream):
            try:
                for line in iter(stream.readline, ''):
                    output_lines.put((name, line, None))
            except Exception as exc:
                output_lines.put((name, None, exc))
            finally:
                output_lines.put((name, None, None))

        with subprocess.Popen(
            [sys.executable, str(ENTRY), *arguments], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', bufsize=1,
        ) as child:
            # Pipe readers work on Windows too; text mode normalizes CRLF.
            readers = [threading.Thread(target=read_lines, args=(name, stream), daemon=True)
                       for name, stream in (('stdout', child.stdout), ('stderr', child.stderr))]
            for reader in readers:
                reader.start()
            open_streams = set(chunks)
            deadline = time.monotonic() + 20
            try:
                child.stdin.write(contents.decode('utf-8'))
                child.stdin.close()
                while open_streams:
                    remaining = deadline - time.monotonic()
                    self.assertGreater(remaining, 0, 'solver did not close its output streams')
                    try:
                        name, line, error = output_lines.get(timeout=remaining)
                    except queue.Empty:
                        self.fail('solver output timed out')
                    self.assertIsNone(error, f'{name} reader failed: {error}')
                    if line is None:
                        open_streams.remove(name)
                        continue
                    chunks[name].append(line)
                    if name == 'stderr' and line.startswith(PREFIX):
                        live_counts.append(int(line[len(PREFIX):]))
                self.assertEqual(child.wait(timeout=5), 0, ''.join(chunks['stderr']))
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                for reader in readers:
                    reader.join(timeout=5)
                    self.assertFalse(reader.is_alive(), 'solver pipe reader did not exit')
        stdout = ''.join(chunks['stdout'])
        stderr = ''.join(chunks['stderr'])
        self.assertEqual(len(stdout.splitlines()), 1, stdout)
        return json.loads(stdout), stderr, live_counts

    def test_real_search_reports_monotonic_counts_matching_final_stats(self):
        counts = []
        result = engine.solve(request(state()), on_solution_count=counts.append)
        self.assertIn(result['status'], ('OPTIMAL', 'FEASIBLE'), result)
        self.assertGreaterEqual(self.assert_count(result), 1)
        self.assertEqual(counts, list(range(1, result['stats']['solutionCount'] + 1)))
        self.assertEqual(len(result['assignments']), 31)

    def test_unique_roster_counts_once_across_all_optimization_phases(self):
        real_solve = cp_model.CpSolver.solve
        for locked in (False, True):
            for partial in (False, True):
                with self.subTest(locked=locked, partial=partial):
                    counts, search_statuses = [], []

                    def tracked_solve(solver, model, *args, **kwargs):
                        status = real_solve(solver, model, *args, **kwargs)
                        search_statuses.append(status)
                        return status

                    with patch.object(cp_model.CpSolver, 'solve', tracked_solve):
                        result = engine.solve(unique_request(locked, partial), on_solution_count=counts.append)
                    self.assertEqual(result['status'], 'OPTIMAL', result)
                    self.assertEqual(len(result['assignments']), 31)
                    self.assertEqual(len(search_statuses), 3 if partial else 2)
                    self.assertTrue(all(status == cp_model.OPTIMAL for status in search_statuses))
                    self.assert_count(result, 1)
                    self.assertEqual(counts, [1])

    def test_auxiliary_variable_changes_do_not_create_another_roster(self):
        model = cp_model.CpModel()
        scheduled = model.new_bool_var('scheduled')
        auxiliary = model.new_bool_var('auxiliary')
        model.add(scheduled == 1)
        counts = []
        counter = engine.SolutionCounter([scheduled], counts.append)
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.max_time_in_seconds = 2
        for objective, expected_auxiliary in ((model.minimize, 0), (model.maximize, 1)):
            objective(auxiliary)
            self.assertEqual(solver.solve(model, counter), cp_model.OPTIMAL)
            self.assertEqual(solver.value(scheduled), 1)
            self.assertEqual(solver.value(auxiliary), expected_auxiliary)
        self.assertEqual(counter.count, 1)
        self.assertEqual(counts, [1])

    def test_infeasible_search_and_conflict_diagnosis_report_zero(self):
        # The arithmetic capacity checks pass, but indivisible shifts make the
        # three weekly minimums impossible in October's four-day first week.
        data = request(state(
            employees=[employee(eid, cap=40, minimum_week=16) for eid in ('a', 'b', 'c')],
            shifts=[shift(mode='fixed')],
        ))
        data['state']['rules']['maxConsecutiveDays'] = 5
        counts = []
        real_explain = engine.ConstraintDiagnostics.explain
        with patch.object(engine.ConstraintDiagnostics, 'explain', autospec=True, side_effect=real_explain) as explain:
            result = engine.solve(data, on_solution_count=counts.append)
        self.assertEqual(result['status'], 'INFEASIBLE', result)
        explain.assert_called_once()
        self.assertTrue(any(issue['type'] == 'constraint-combination' for issue in result['issues']), result)
        self.assertNotIn('assignments', result)
        self.assert_count(result, 0)
        self.assertEqual(counts, [])

    def test_invalid_requests_never_report_solutions(self):
        for data in (None, {}, {'protocolVersion': 99}, {'protocolVersion': 1, 'state': {}}):
            with self.subTest(request=data):
                counts = []
                result = engine.solve(data, on_solution_count=counts.append)
                self.assertEqual(result['status'], 'MODEL_INVALID', result)
                self.assert_count(result, 0)
                self.assertEqual(counts, [])

    def test_progress_callback_failure_does_not_change_the_result(self):
        baseline = engine.solve(unique_request())
        counts = []

        def broken_observer(count):
            counts.append(count)
            raise RuntimeError('observer disconnected')

        result = engine.solve(unique_request(), on_solution_count=broken_observer)
        self.assertEqual(result['status'], baseline['status'])
        self.assertEqual(result['assignments'], baseline['assignments'])
        self.assertEqual(result['issues'], baseline['issues'])
        self.assert_count(result, 1)
        self.assertEqual(counts, [1])
        self.assertNotIn('observer disconnected', json.dumps(result))

    def test_hosted_callback_flushes_each_event_before_final_emit(self):
        output, diagnostics = io.StringIO(), FlushRecorder()
        expected = {'protocolVersion': 1, 'stats': {'solutionCount': 2}}

        def fake_solve(data, on_solution_count=None):
            self.assertEqual(data, {'requestId': 'stream-order'})
            self.assertTrue(callable(on_solution_count))
            for count in (1, 2):
                on_solution_count(count)
                self.assertEqual(output.getvalue(), '', 'final JSON appeared before solve finished')
                self.assertTrue(diagnostics.flushed_values)
                self.assertTrue(diagnostics.flushed_values[-1].endswith(f'{PREFIX}{count}\n'))
            return expected

        with patch.object(entry.sys, 'argv', ['main.py', '--hosted']), \
                patch.object(entry, 'load_engine', return_value=fake_solve), \
                patch.object(entry, 'read_request', return_value={'requestId': 'stream-order'}), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostics):
            entry.main()
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        events = [line for line in diagnostics.getvalue().splitlines() if line.startswith(PREFIX)]
        self.assertEqual(events, [f'{PREFIX}1', f'{PREFIX}2'])

    def test_hosted_real_process_streams_counts_and_one_final_json(self):
        result, stderr, live_counts = self.run_streamed(['--hosted'], json.dumps(unique_request()).encode())
        self.assertEqual(result['status'], 'OPTIMAL', result)
        self.assert_count(result, 1)
        self.assertEqual(live_counts, [1])
        self.assertIn('SHIFTFLOW_STAGE_V1:solving\n', stderr)
        self.assertIn('SHIFTFLOW_STAGE_V1:finishing\n', stderr)

    def test_self_test_has_no_scheduling_solution_events(self):
        result, stderr, live_counts = self.run_streamed(['--hosted', '--self-test'])
        self.assertTrue(result['selfTest'])
        self.assertEqual(result['status'], 'OPTIMAL')
        self.assertEqual(live_counts, [])
        self.assertNotIn(PREFIX, stderr)

    def test_plain_cli_counts_solutions_without_writing_stderr(self):
        result, stderr, live_counts = self.run_streamed([], json.dumps(unique_request()).encode())
        self.assertEqual(result['status'], 'OPTIMAL', result)
        self.assert_count(result, 1)
        self.assertEqual(stderr, '')
        self.assertEqual(live_counts, [])

    def test_invalid_json_has_zero_solutions_in_both_cli_modes(self):
        for arguments in ([], ['--hosted']):
            with self.subTest(arguments=arguments):
                result, stderr, live_counts = self.run_streamed(arguments, b'{invalid')
                self.assertEqual(result['status'], 'MODEL_INVALID', result)
                self.assert_count(result, 0)
                self.assertEqual(live_counts, [])
                self.assertNotIn(PREFIX, stderr)


if __name__ == '__main__':
    unittest.main()
