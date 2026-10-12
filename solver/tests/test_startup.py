"""Import diagnostics are separate from scheduling and preserve the JSON channel."""
import contextlib
import importlib.util
import io
import pathlib
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('startup_entry', pathlib.Path(__file__).parents[1] / 'main.py')
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)


class StartupDiagnosticsTests(unittest.TestCase):
    def test_hosted_imports_are_traced_on_stderr_and_watchdog_is_cancelled(self):
        engine = types.ModuleType('engine')
        engine.solve = lambda request: request
        output, diagnostic = io.StringIO(), io.StringIO()
        with patch.object(entry.sys, 'argv', ['main.py', '--hosted']), \
                patch.dict('sys.modules', {'engine': engine}), \
                patch('faulthandler.dump_traceback_later') as arm, \
                patch('faulthandler.cancel_dump_traceback_later') as cancel, \
                patch('importlib.import_module') as loader, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostic):
            self.assertIs(entry.load_engine(), engine.solve)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual([call.args[0] for call in loader.call_args_list], ['numpy', 'pandas', 'ortools.sat.python.cp_model'])
        for name in ['numpy', 'pandas', 'ortools.sat.python.cp_model', 'engine']:
            self.assertIn(f'SHIFTFLOW_IMPORT_V1:{name}:begin:', diagnostic.getvalue())
            self.assertIn(f'SHIFTFLOW_IMPORT_V1:{name}:ready:', diagnostic.getvalue())
        arm.assert_called_once()
        self.assertEqual(arm.call_args.args, (20,))
        self.assertFalse(arm.call_args.kwargs['repeat'])
        cancel.assert_called_once()

    def test_failure_identifies_the_dependency_and_cancels_traceback_timer(self):
        def loader(name):
            if name == 'pandas':
                raise ImportError('fixture native dependency failure')
        diagnostic = io.StringIO()
        with patch.object(entry.sys, 'argv', ['main.py', '--hosted']), \
                patch('faulthandler.dump_traceback_later'), \
                patch('faulthandler.cancel_dump_traceback_later') as cancel, \
                patch('importlib.import_module', side_effect=loader), \
                contextlib.redirect_stderr(diagnostic):
            with self.assertRaisesRegex(ImportError, 'fixture native dependency failure'):
                entry.load_engine()
        self.assertIn('SHIFTFLOW_IMPORT_V1:pandas:begin:', diagnostic.getvalue())
        self.assertNotIn('SHIFTFLOW_IMPORT_V1:pandas:ready:', diagnostic.getvalue())
        self.assertNotIn('SHIFTFLOW_IMPORT_V1:ortools.sat.python.cp_model:begin:', diagnostic.getvalue())
        cancel.assert_called_once()

    def test_plain_cli_keeps_silent_import_behavior(self):
        engine = types.ModuleType('engine')
        engine.solve = lambda request: request
        diagnostic = io.StringIO()
        with patch.object(entry.sys, 'argv', ['main.py']), \
                patch.dict('sys.modules', {'engine': engine}), \
                contextlib.redirect_stderr(diagnostic):
            self.assertIs(entry.load_engine(), engine.solve)
        self.assertEqual(diagnostic.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
