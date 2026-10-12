"""One bounded JSON request on stdin, exactly one JSON response on stdout."""
import json
import sys

MAX_INPUT_BYTES = 8 * 1024 * 1024


def stage(name):
    # The desktop host tracks startup separately from the solver's time budget.
    # Keep stdout as exactly one result JSON for existing command-line callers.
    if '--hosted' in sys.argv[1:]:
        sys.stderr.write(f'SHIFTFLOW_STAGE_V1:{name}\n')
        sys.stderr.flush()


def emit(result):
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    stage('finishing')


def main():
    stage('loading')
    # Import the real native engine after announcing the stage. This lets the
    # host distinguish a slow Python/native-library startup from a slow model.
    from engine import solve
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
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError('请求超过 8 MiB 上限。')
        request = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f'不支持非有限数字 {value}')))
        stage('solving')
        result = solve(request)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        result = {'protocolVersion': 1, 'requestId': '', 'engine': 'ortools-cp-sat', 'status': 'MODEL_INVALID', 'issues': [{'id': 'invalid-json', 'type': 'configuration', 'severity': 'error', 'message': str(exc)[:500]}], 'stats': {'wallTimeSeconds': 0, 'shortageCount': 0, 'optimal': False}, 'message': '请求数据无效，原排班未修改。'}
    emit(result)


if __name__ == '__main__':
    main()
