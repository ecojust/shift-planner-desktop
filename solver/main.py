"""One bounded JSON request from stdin or --input, one JSON response on stdout."""
import json
import sys
import time

MAX_INPUT_BYTES = 8 * 1024 * 1024


def stage(name):
    # The desktop host tracks startup separately from the solver's time budget.
    # Keep stdout as exactly one result JSON for existing command-line callers.
    if '--hosted' in sys.argv[1:]:
        sys.stderr.write(f'SHIFTFLOW_STAGE_V1:{name}\n')
        sys.stderr.flush()


def solution_count(count):
    # Only the hosted protocol has a progress channel. The engine isolates
    # callback I/O failures and continues solving with an accurate final count.
    sys.stderr.write(f'SHIFTFLOW_SOLUTIONS_V1:{count}\n')
    sys.stderr.flush()


def emit(result):
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    stage('finishing')


def load_engine():
    if '--hosted' not in sys.argv[1:]:
        from engine import solve
        return solve
    # Native dependency initialization can be slow or stall before any search
    # starts. Mark the actual imports, without changing stdout or model rules.
    import faulthandler
    import importlib
    began = time.monotonic()
    traceback_scheduled = False

    def diagnostic(module, action):
        sys.stderr.write(f'SHIFTFLOW_IMPORT_V1:{module}:{action}:{time.monotonic() - began:.3f}s\n')
        sys.stderr.flush()

    try:
        try:
            # One bounded traceback identifies the exact blocked import even
            # when the native loader never returns. The host still owns timeout.
            faulthandler.dump_traceback_later(20, repeat=False, file=sys.stderr)
            traceback_scheduled = True
        except (OSError, RuntimeError, ValueError):
            pass  # A redirected in-memory stderr may not have a file descriptor.
        for module in ('numpy', 'pandas', 'ortools.sat.python.cp_model'):
            diagnostic(module, 'begin')
            importlib.import_module(module)
            diagnostic(module, 'ready')
        diagnostic('engine', 'begin')
        from engine import solve
        diagnostic('engine', 'ready')
        return solve
    finally:
        if traceback_scheduled:
            faulthandler.cancel_dump_traceback_later()


def read_request():
    """File replay must not wait for stdin EOF, including under an IDE debugger."""
    arguments = sys.argv[1:]
    if '--input' in arguments:
        if arguments.count('--input') != 1:
            raise ValueError('--input 只能指定一个规则 JSON 文件。')
        index = arguments.index('--input')
        if index + 1 == len(arguments) or arguments[index + 1].startswith('--'):
            raise ValueError('--input 后需要指定规则 JSON 文件路径。')
        try:
            with open(arguments[index + 1], 'rb') as source:
                raw = source.read(MAX_INPUT_BYTES + 1)
        except OSError:
            # Do not copy private local paths from an exception into the result.
            raise ValueError('无法读取规则 JSON 文件，请检查文件是否存在及读取权限。') from None
    else:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('请求超过 8 MiB 上限。')
    return json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'不支持非有限数字 {value}')))


def main():
    stage('loading')
    # Import the real native engine after announcing the stage. This lets the
    # host distinguish a slow Python/native-library startup from a slow model.
    solve = load_engine()
    if '--self-test' in sys.argv[1:]:
        import ortools
        from ortools.sat.python import cp_model
        stage('solving')
        model = cp_model.CpModel()
        first, second = model.new_bool_var('first'), model.new_bool_var('second')
        model.add(first + second == 1)
        model.maximize(2 * first + second)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 2
        solver.parameters.num_search_workers = 2
        status = solver.solve(model)
        if status != cp_model.OPTIMAL or solver.value(first) != 1 or solver.value(second) != 0:
            raise RuntimeError('本机 CP-SAT 自检未完成预期的约束计算。')
        emit({'engine': 'ortools-cp-sat', 'protocolVersion': 1, 'version': ortools.__version__, 'local': True, 'selfTest': True, 'status': 'OPTIMAL'})
        return
    if '--info' in sys.argv[1:]:
        import ortools
        emit({'engine': 'ortools-cp-sat', 'protocolVersion': 1, 'version': ortools.__version__, 'local': True})
        return
    try:
        stage('reading')
        request = read_request()
        stage('solving')
        result = solve(request, on_solution_count=solution_count) if '--hosted' in sys.argv[1:] else solve(request)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        result = {'protocolVersion': 1, 'requestId': '', 'engine': 'ortools-cp-sat', 'status': 'MODEL_INVALID', 'issues': [{'id': 'invalid-json', 'type': 'configuration', 'severity': 'error', 'message': str(exc)[:500]}], 'stats': {'wallTimeSeconds': 0, 'shortageCount': 0, 'optimal': False, 'solutionCount': 0}, 'message': '请求数据无效，原排班未修改。'}
    emit(result)


if __name__ == '__main__':
    main()
