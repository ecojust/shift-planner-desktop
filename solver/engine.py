"""Bounded, local-only CP-SAT employee roster solver (civil UTC minutes)."""
from __future__ import annotations

import calendar
import copy
import datetime as dt
import math
import time
from collections import defaultdict
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from typing import Any

from ortools.sat.python import cp_model

ENGINE = 'ortools-cp-sat'
DAY = 1440
MAX_EMPLOYEES = 200
MAX_SHIFTS = 24
MAX_ASSIGNMENTS = 20000
MAX_VARIABLES = 150000


class InvalidInput(ValueError):
    pass


class TimeBudgetExceeded(Exception):
    pass


def issue(kind: str, message: str, **extra: Any) -> dict:
    return {'id': kind, 'type': kind, 'severity': 'error', 'message': message, **extra}


def _obj(value, name):
    if not isinstance(value, dict):
        raise InvalidInput(f'{name}必须是对象。')
    return value


def _list(value, name, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise InvalidInput(f'{name}必须是数组，且不能超过 {maximum} 项。')
    return value


def _str(value, name, maximum=200):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise InvalidInput(f'{name}必须为 1–{maximum} 个字符。')
    return value


def _num(value, name, lo, hi, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi or (integer and int(value) != value):
        raise InvalidInput(f'{name}必须为 {lo}–{hi} 范围内的{"整数" if integer else "数字"}。')
    return value


def _date(text):
    if not isinstance(text, str) or len(text) != 10:
        raise InvalidInput('日期必须为 YYYY-MM-DD 格式。')
    try:
        value = dt.date.fromisoformat(text)
    except ValueError as exc:
        raise InvalidInput(f'无效日期：{text}。') from exc
    if value.isoformat() != text or value.year < 1900 or value.year > 2200:
        raise InvalidInput('排班日期应在 1900–2200 年之间，使用 YYYY-MM-DD 格式。')
    return value.toordinal()


def _clock(text):
    if not isinstance(text, str) or len(text) != 5 or text[2] != ':' or not (text[:2] + text[3:]).isdigit():
        raise InvalidInput('班次时间必须为 HH:MM 格式。')
    h, m = int(text[:2]), int(text[3:])
    if h > 23 or m > 59:
        raise InvalidInput('班次时间超出 00:00–23:59 范围。')
    return h * 60 + m


def _minutes(value, rounding):
    # Integer work minutes cannot exceed a fractional limit or undershoot rest.
    return int((Decimal(str(value)) * 60).to_integral_value(rounding=rounding))


def week_parts(start: int, end: int):
    while start < end:
        day = start // DAY
        week = day - dt.date.fromordinal(day).weekday()
        boundary = min(end, (week + 7) * DAY)
        yield week, boundary - start
        start = boundary


def validate_request(request):
    _obj(request, '请求')
    if request.get('protocolVersion') != 1 or isinstance(request.get('protocolVersion'), bool):
        raise InvalidInput('不支持的求解协议版本。')
    _str(request.get('requestId'), '请求标识', 128)
    state = _obj(request.get('state'), '排班数据')
    if state.get('version') != 1 or isinstance(state.get('version'), bool):
        raise InvalidInput('不支持的排班数据版本。')
    month = _str(state.get('month'), '排班月份', 7)
    if len(month) != 7:
        raise InvalidInput('排班月份必须为 YYYY-MM。')
    first = _date(month + '-01')
    d = dt.date.fromordinal(first)
    dates = list(range(first, first + calendar.monthrange(d.year, d.month)[1]))
    employees = _list(state.get('employees'), '员工', MAX_EMPLOYEES)
    shifts = _list(state.get('shifts'), '班次', MAX_SHIFTS)
    assignments = _list(state.get('assignments'), '排班记录', MAX_ASSIGNMENTS)
    if not employees or not shifts:
        raise InvalidInput('请至少设置一名员工和一个班次。')
    if len(employees) * len(shifts) * len(dates) > MAX_VARIABLES:
        raise InvalidInput('模型规模超过上限，请缩减员工或班次数量。')
    rules = _obj(state.get('rules'), '规则')
    _num(rules.get('minRestHours'), '最短休息小时数', 0, 168)
    _num(rules.get('maxConsecutiveDays'), '连续工作日上限', 1, 366, True)
    if not isinstance(rules.get('balanceWeekends'), bool):
        raise InvalidInput('周末公平轮班开关必须为布尔值。')
    shift_ids = set()
    for shift in shifts:
        _obj(shift, '班次')
        sid = _str(shift.get('id'), '班次标识', 100)
        if sid == 'off' or sid in shift_ids:
            raise InvalidInput('班次标识重复或使用了保留值 off。')
        shift_ids.add(sid)
        if _clock(shift.get('start')) == _clock(shift.get('end')):
            raise InvalidInput('班次开始和结束时间不能相同。')
        _num(shift.get('required'), '每日班次需求', 0, MAX_EMPLOYEES, True)
    employee_ids = set()
    for emp in employees:
        _obj(emp, '员工')
        eid = _str(emp.get('id'), '员工标识', 100)
        if eid in employee_ids:
            raise InvalidInput('员工标识不能重复。')
        employee_ids.add(eid)
        _num(emp.get('maxHoursPerWeek'), '每周工时上限', 0, 168)
        eligible = _list(emp.get('eligibleShiftIds'), '可排班次', MAX_SHIFTS)
        if any(not isinstance(x, str) or x not in shift_ids for x in eligible) or len(set(eligible)) != len(eligible):
            raise InvalidInput('可排班次含不存在或重复的班次。')
        leave = _list(emp.get('unavailableDates'), '请假日期', 3660)
        for date in leave:
            _date(date)
    groups = _list(rules.get('separationGroups', []), '同班互斥分组', 500)
    group_ids = set()
    group_budget = 0
    for group in groups:
        _obj(group, '互斥分组')
        gid = _str(group.get('id'), '互斥分组标识', 100)
        if gid in group_ids:
            raise InvalidInput('互斥分组标识重复。')
        group_ids.add(gid)
        members = _list(group.get('employeeIds'), '互斥组成员', MAX_EMPLOYEES)
        selected = _list(group.get('shiftIds'), '互斥班次', MAX_SHIFTS)
        if any(not isinstance(x, str) or x not in employee_ids for x in members) or len(set(members)) != len(members):
            raise InvalidInput('互斥分组含不存在或重复的员工。')
        if any(not isinstance(x, str) or x not in shift_ids for x in selected) or len(set(selected)) != len(selected):
            raise InvalidInput('互斥分组含不存在或重复的班次。')
        group_budget += len(members) * max(1, len(selected) or len(shifts)) * len(dates)
    if group_budget > 2_000_000:
        raise InvalidInput('互斥分组约束过多，请合并重复分组。')
    for assignment in assignments:
        _obj(assignment, '排班记录')
        if not isinstance(assignment.get('employeeId'), str) or assignment['employeeId'] not in employee_ids:
            raise InvalidInput('排班记录引用了不存在的员工。')
        if not isinstance(assignment.get('shiftId'), str) or (assignment['shiftId'] != 'off' and assignment['shiftId'] not in shift_ids):
            raise InvalidInput('排班记录引用了不存在的班次。')
        _date(assignment.get('date'))
        if not isinstance(assignment.get('locked'), bool):
            raise InvalidInput('排班锁定标记必须为布尔值。')
    options = _obj(request.get('options', {}), '求解选项')
    _num(options.get('timeLimitSeconds', 15), '求解时限', 0.01, 60)
    _num(options.get('seed', 1010), '随机种子', 0, 2147483647, True)
    if not isinstance(options.get('allowPartial', False), bool):
        raise InvalidInput('允许缺员选项必须为布尔值。')
    return state, dates, options


def solve(request: Any) -> dict:
    began = time.monotonic()
    request_id = request.get('requestId', '') if isinstance(request, dict) else ''
    if not isinstance(request_id, str):
        request_id = ''

    def response(status, message, issues=None, assignments=None, solver=None, shortage=0, objective=None, bound=None):
        stats = {'wallTimeSeconds': round(time.monotonic() - began, 6), 'shortageCount': shortage, 'optimal': status == 'OPTIMAL'}
        if objective is not None:
            stats['objectiveValue'] = objective
        if bound is not None:
            stats['bestBound'] = bound
        result = {'protocolVersion': 1, 'requestId': request_id, 'engine': ENGINE, 'status': status, 'issues': issues or [], 'stats': stats, 'message': message}
        if assignments is not None:
            result['assignments'] = assignments
        return result

    try:
        state, dates, options = validate_request(request)
        deadline = began + options.get('timeLimitSeconds', 15)
        def check_time():
            if time.monotonic() >= deadline:
                raise TimeBudgetExceeded()
        employees = state['employees']
        shifts = state['shifts']
        emap = {e['id']: e for e in employees}
        smap = {s['id']: s for s in shifts}
        shift_times = {s['id']: (_clock(s['start']), (_clock(s['end']) - _clock(s['start'])) % DAY) for s in shifts}
        leave = {e['id']: {_date(x) for x in e['unavailableDates']} for e in employees}
        rest = _minutes(state['rules']['minRestHours'], ROUND_CEILING)
        consecutive = int(state['rules']['maxConsecutiveDays'])
        caps = {e['id']: _minutes(e['maxHoursPerWeek'], ROUND_FLOOR) for e in employees}
        active = set(dates)
        fixed = [copy.deepcopy(a) for a in state['assignments'] if a['locked'] or _date(a['date']) not in active]
        fixed_cells = {}
        fixed_work = defaultdict(list)
        fixed_days = defaultdict(set)
        fixed_weeks = defaultdict(lambda: defaultdict(int))
        fixed_coverage = defaultdict(set)
        conflicts = []
        for a in fixed:
            eid, sid, day = a['employeeId'], a['shiftId'], _date(a['date'])
            cell = (eid, day)
            if cell in fixed_cells:
                conflicts.append(issue('duplicate', f'{a["date"]} 同一员工有多条固定排班（含锁定休息）。', date=a['date'], employeeId=eid))
            fixed_cells[cell] = a
            if sid == 'off':
                continue
            start_clock, duration = shift_times[sid]
            start, end = day * DAY + start_clock, day * DAY + start_clock + duration
            if sid not in emap[eid]['eligibleShiftIds']:
                conflicts.append(issue('qualification', '固定排班违反员工班次资格，请先调整锁定排班或月外历史。', date=a['date'], employeeId=eid))
            if any(x in leave[eid] for x in range(start // DAY, (end - 1) // DAY + 1)):
                conflicts.append(issue('unavailable', '固定排班与整日请假重叠（包含跨夜部分）。', date=a['date'], employeeId=eid))
            fixed_work[eid].append((start, end, a))
            fixed_days[eid].add(day)
            fixed_coverage[(day, sid)].add(eid)
            for week, minutes in week_parts(start, end):
                fixed_weeks[eid][week] += minutes
        for eid in emap:
            work = sorted(fixed_work[eid], key=lambda item: (item[0], item[1]))
            for previous, current in zip(work, work[1:]):
                if current[0] < previous[1] + rest:
                    conflicts.append(issue('rest', '固定排班间休息不足或时间重叠，请先调整锁定排班或月外历史。', employeeId=eid, date=current[2]['date']))
            if any(value > caps[eid] for value in fixed_weeks[eid].values()):
                conflicts.append(issue('weekly-hours', '固定排班已超过周一至周日自然周工时上限。', employeeId=eid))
            run, last = 0, -10000
            for day in sorted(fixed_days[eid]):
                run = run + 1 if day == last + 1 else 1
                if run == consecutive + 1:
                    conflicts.append(issue('consecutive-days', '固定排班超过连续工作日上限。', employeeId=eid))
                last = day
        for group in state['rules'].get('separationGroups', []):
            members = set(group['employeeIds'])
            selected = set(group['shiftIds']) or set(smap)
            if any(len(staff & members) > 1 for (_, sid), staff in fixed_coverage.items() if sid in selected):
                conflicts.append(issue('separation', f'固定排班违反同班互斥分组“{group.get("name", group["id"])}”。'))
        for (day, sid), staff in fixed_coverage.items():
            if day in active and len(staff) > smap[sid]['required']:
                conflicts.append(issue('overstaffed', '锁定排班已超出本月班次需求，请先调整锁定或需求人数。', date=dt.date.fromordinal(day).isoformat()))
        if conflicts:
            for index, item in enumerate(conflicts):
                item['id'] = f'{item["type"]}-{index}'
            return response('INFEASIBLE', '固定排班存在硬约束冲突，原排班未修改。', conflicts)
        check_time()
        model = cp_model.CpModel()
        x = {}
        cells = defaultdict(list)
        coverage = defaultdict(list)
        weekly = defaultdict(lambda: defaultdict(list))
        total_minutes = defaultdict(list)
        shift_counts = defaultdict(list)
        weekends = defaultdict(list)
        fixed_current_minutes = defaultdict(int)
        fixed_current_shifts = defaultdict(int)
        fixed_current_weekends = defaultdict(int)
        for e in employees:
            check_time()
            eid = e['id']
            intervals = []
            for start, end, a in fixed_work[eid]:
                intervals.append(model.new_fixed_size_interval_var(start, end - start + rest, f'fixed_{eid}_{a["date"]}'))
                day = _date(a['date'])
                if day in active:
                    fixed_current_minutes[eid] += end - start
                    fixed_current_shifts[(eid, a['shiftId'])] += 1
                    if dt.date.fromordinal(day).weekday() >= 5:
                        fixed_current_weekends[eid] += 1
            for day in dates:
                if (eid, day) in fixed_cells:
                    continue
                for sid in e['eligibleShiftIds']:
                    if smap[sid]['required'] == 0 or caps[eid] == 0:
                        continue
                    clock, duration = shift_times[sid]
                    start, end = day * DAY + clock, day * DAY + clock + duration
                    if any(d in leave[eid] for d in range(start // DAY, (end - 1) // DAY + 1)):
                        continue
                    # Remove impossible candidates before building optional intervals.
                    if any(start < fend + rest and fstart < end + rest for fstart, fend, _ in fixed_work[eid]):
                        continue
                    parts = list(week_parts(start, end))
                    if any(minutes + fixed_weeks[eid][week] > caps[eid] for week, minutes in parts):
                        continue
                    var = model.new_bool_var(f'x_{eid}_{day}_{sid}')
                    x[(eid, day, sid)] = var
                    cells[(eid, day)].append(var)
                    coverage[(day, sid)].append(var)
                    total_minutes[eid].append(duration * var)
                    shift_counts[(eid, sid)].append(var)
                    if dt.date.fromordinal(day).weekday() >= 5:
                        weekends[eid].append(var)
                    for week, minutes in parts:
                        weekly[eid][week].append(minutes * var)
                    intervals.append(model.new_optional_fixed_size_interval_var(start, duration + rest, var, f'i_{eid}_{day}_{sid}'))
                if cells[(eid, day)]:
                    model.add(sum(cells[(eid, day)]) <= 1)
            if intervals:
                model.add_no_overlap(intervals)
            for week, terms in weekly[eid].items():
                model.add(sum(terms) + fixed_weeks[eid][week] <= caps[eid])
            for first_day in range(dates[0] - consecutive, dates[-1] + 1):
                last_day = first_day + consecutive
                terms = [var for day in dates if first_day <= day <= last_day for var in cells[(eid, day)]]
                prior = sum(first_day <= day <= last_day for day in fixed_days[eid])
                if terms:
                    model.add(sum(terms) + prior <= consecutive)
        check_time()
        for group in state['rules'].get('separationGroups', []):
            for day in dates:
                for sid in group['shiftIds'] or smap:
                    terms = [x[(eid, day, sid)] for eid in group['employeeIds'] if (eid, day, sid) in x]
                    prior = len(fixed_coverage[(day, sid)] & set(group['employeeIds']))
                    if terms:
                        model.add(sum(terms) + prior <= 1)
        shortages = []
        allow_partial = options.get('allowPartial', False)
        for day in dates:
            for s in shifts:
                target = s['required'] - len(fixed_coverage[(day, s['id'])])
                terms = coverage[(day, s['id'])]
                if allow_partial:
                    shortage = model.new_int_var(0, target, f'shortage_{day}_{s["id"]}')
                    shortages.append(shortage)
                    model.add(sum(terms) + shortage == target)
                else:
                    model.add(sum(terms) == target)
        # Fairness is secondary: normalized workload, shift rotation, weekends.
        fairness_terms = []
        load_vars = []
        max_month_minutes = len(dates) * 1439
        for e in employees:
            eid = e['id']
            if caps[eid] <= 0 or not (total_minutes[eid] or fixed_current_minutes[eid]):
                continue
            minutes = model.new_int_var(0, max_month_minutes, f'minutes_{eid}')
            model.add(minutes == sum(total_minutes[eid]) + fixed_current_minutes[eid])
            scaled = model.new_int_var(0, max_month_minutes * 1000, f'load_{eid}')
            model.add_division_equality(scaled, minutes * 1000, caps[eid])
            load_vars.append(scaled)
        def spread(terms, bound, label, weight):
            if len(terms) < 2:
                return
            low = model.new_int_var(0, bound, f'{label}_min')
            high = model.new_int_var(0, bound, f'{label}_max')
            model.add_min_equality(low, terms)
            model.add_max_equality(high, terms)
            fairness_terms.append((high - low) * weight)
        spread(load_vars, max_month_minutes * 1000, 'workload', 10)
        for sid in smap:
            counts = [sum(shift_counts[(e['id'], sid)]) + fixed_current_shifts[(e['id'], sid)] for e in employees if shift_counts[(e['id'], sid)] or fixed_current_shifts[(e['id'], sid)]]
            spread(counts, len(dates), f'shift_{sid}', 200)
        if state['rules']['balanceWeekends']:
            counts = [sum(weekends[e['id']]) + fixed_current_weekends[e['id']] for e in employees if weekends[e['id']] or fixed_current_weekends[e['id']]]
            spread(counts, len(dates), 'weekends', 300)
        fairness = sum(fairness_terms)
        check_time()
        error = model.validate()
        if error:
            return response('MODEL_INVALID', '求解模型无效，原排班未修改。', [issue('model-invalid', error[:1000])])
        def run(limit):
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = max(0.001, limit)
            solver.parameters.num_search_workers = 2
            solver.parameters.random_seed = int(options.get('seed', 1010))
            solver.parameters.log_search_progress = False
            status = solver.solve(model)
            return solver, status
        def extract(solver):
            result = copy.deepcopy(fixed)
            for (eid, day, sid), var in x.items():
                if solver.value(var):
                    result.append({'employeeId': eid, 'date': dt.date.fromordinal(day).isoformat(), 'shiftId': sid, 'locked': False})
            return sorted(result, key=lambda a: (a['date'], a['employeeId'], a['shiftId']))
        phase_one_optimal = True
        saved_assignments = None
        shortage_count = 0
        if allow_partial:
            model.minimize(sum(shortages))
            # Obtain a provably minimum shortfall before optimizing fairness.
            remaining = deadline - time.monotonic()
            solver, status = run(remaining * 0.7)
            if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                saved_assignments = extract(solver)
                shortage_count = sum(solver.value(var) for var in shortages)
                phase_one_optimal = status == cp_model.OPTIMAL
                if phase_one_optimal and deadline - time.monotonic() > 0.01:
                    model.add(sum(shortages) == shortage_count)
                    for var in x.values():
                        model.add_hint(var, solver.value(var))
                    model.minimize(fairness)
                    solver, status = run(deadline - time.monotonic())
                else:
                    return _success(response, saved_assignments, 'FEASIBLE', state, shortage_count, None, None, '已找到最少缺员的可行方案，公平轮班优化达到时限。' if phase_one_optimal else '已找到满足全部硬约束的缺员方案；时限内尚未证明缺员数最少。')
        else:
            model.minimize(fairness)
            solver, status = run(deadline - time.monotonic())
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            final_status = 'OPTIMAL' if status == cp_model.OPTIMAL and phase_one_optimal else 'FEASIBLE'
            return _success(response, extract(solver), final_status, state, shortage_count, solver.objective_value, solver.best_objective_bound)
        if saved_assignments is not None and status == cp_model.UNKNOWN:
            return _success(response, saved_assignments, 'FEASIBLE', state, shortage_count, None, None, '已找到最少缺员的可行方案，公平轮班优化达到时限。')
        if status == cp_model.INFEASIBLE:
            return response('INFEASIBLE', '已证明当前硬约束无法同时满足，原排班未修改。请检查需求人数、请假、工时、班间休息和同班互斥；也可明确开启允许缺员后重试。', [issue('infeasible', '现有人员、班次需求与硬规则存在冲突。')])
        if status == cp_model.MODEL_INVALID:
            return response('MODEL_INVALID', '求解器拒绝了无效模型，原排班未修改。', [issue('model-invalid', solver.solution_info()[:1000])])
        return response('UNKNOWN', '求解达到时限，尚未找到可行方案；这不代表无解。原排班未修改。', [issue('timeout', '可增加求解时限后重试。')])
    except InvalidInput as exc:
        return response('MODEL_INVALID', str(exc), [issue('configuration', str(exc))])
    except TimeBudgetExceeded:
        return response('UNKNOWN', '建模达到求解时限，尚未找到可行方案；这不代表无解。原排班未修改。', [issue('timeout', '请增加求解时限或缩减模型。')])
    except Exception as exc:
        # The caller never receives an empty replacement roster on failure.
        return response('ERROR', '本地求解失败，原排班未修改。', [issue('solver-error', f'{type(exc).__name__}: {str(exc)[:500]}')])


def _success(response, assignments, status, state, shortage, objective, bound, message=None):
    coverage = defaultdict(int)
    for a in assignments:
        if a['shiftId'] != 'off':
            coverage[(a['date'], a['shiftId'])] += 1
    shortages = []
    month = state['month']
    first = dt.date.fromisoformat(month + '-01')
    for day in range(1, calendar.monthrange(first.year, first.month)[1] + 1):
        date = f'{month}-{day:02d}'
        for shift in state['shifts']:
            missing = shift['required'] - coverage[(date, shift['id'])]
            if missing > 0:
                shortages.append({'id': f'coverage-{date}-{shift["id"]}', 'type': 'coverage', 'severity': 'warning', 'date': date, 'message': f'{date} {shift.get("name", shift["id"])}缺 {missing} 人。'})
    if message is None:
        message = '已找到最优排班方案。' if status == 'OPTIMAL' else '已找到可行排班方案；时限内尚未证明公平性最优。'
        if shortage:
            message += f' 已明确允许缺员，本月仍缺 {shortage} 个班次人次。'
    return response(status, message, shortages, assignments, shortage=shortage, objective=objective, bound=bound)
