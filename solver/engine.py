"""Bounded, local-only CP-SAT employee roster solver (civil UTC minutes)."""
from __future__ import annotations

import calendar
import copy
import datetime as dt
import hashlib
import math
import re
import time
from collections import defaultdict
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from typing import Any, Callable

from ortools.sat.python import cp_model
from diagnostics import ConstraintDiagnostics, daily_capacity_issues, weekday_capacity_issues, problem

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


class SolutionCounter(cp_model.CpSolverSolutionCallback):
    """Count distinct rosters across optimization phases, not auxiliary values."""

    def __init__(self, variables, on_solution_count: Callable[[int], None] | None = None):
        super().__init__()
        self._indexes = tuple(variable.index for variable in variables)
        self._seen: set[bytes] = set()
        self._notify = on_solution_count
        self.count = 0

    def on_solution_callback(self):
        # The response is one consistent native snapshot. Reading its indexed
        # values avoids a separate Python/native call for every boolean. Keep
        # only a fixed-size digest per roster, never its full assignment list.
        # Fixed/month-external records are constant throughout this request.
        try:
            values = self.response_proto.solution
            signature = hashlib.blake2b(bytes(values[index] for index in self._indexes), digest_size=32).digest()
            if signature in self._seen:
                return
            self._seen.add(signature)
            self.count += 1
            if self._notify is not None:
                try:
                    self._notify(self.count)
                except Exception:
                    # Progress is optional; a closed display/pipe must not
                    # turn a valid solve into an error or stop the search.
                    self._notify = None
        except Exception:
            # Counting must not change CP-SAT's result, even if progress
            # bookkeeping itself is unavailable (for example, memory pressure).
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


def overlap_minutes(start: int, end: int, lower: int, upper: int):
    return max(0, min(end, upper) - max(start, lower))


def _hours_text(minutes: int):
    return f'{minutes / 60:.2f}'.rstrip('0').rstrip('.')


def weekday_targets(config, days, full_total):
    """Project a full-week budget onto known/plannable days, without renormalizing."""
    chosen = set(config['days'])
    selected = [day for day in days if dt.date.fromordinal(day).weekday() + 1 in chosen]
    others = [day for day in days if day not in selected]
    full_selected = (full_total * int(config['percent']) + 99) // 100
    full_other = full_total - full_selected
    selected_target = (full_selected * len(selected) + len(chosen) - 1) // len(chosen)
    other_count = 7 - len(chosen)
    other_target = (full_other * len(others) + other_count - 1) // other_count if other_count else 0
    return selected, others, selected_target, other_target


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
    horizon_length = len(dates) + d.weekday() + 6 - dt.date.fromordinal(dates[-1]).weekday()
    employees = _list(state.get('employees'), '员工', MAX_EMPLOYEES)
    shifts = _list(state.get('shifts'), '班次', MAX_SHIFTS)
    assignments = _list(state.get('assignments'), '排班记录', MAX_ASSIGNMENTS)
    if not employees or not shifts:
        raise InvalidInput('请至少设置一名员工和一个班次。')
    if len(employees) * len(shifts) * horizon_length > MAX_VARIABLES:
        raise InvalidInput('模型规模超过上限，请缩减员工或班次数量。')
    rules = _obj(state.get('rules'), '规则')
    _num(rules.get('minRestHours'), '最短休息小时数', 0, 168)
    _num(rules.get('maxConsecutiveDays'), '连续工作日上限', 1, 366, True)
    weights = rules.get('weekdayWeights')
    if 'weekdayWeights' in rules:
        _obj(weights, '星期权重')
        weighted_days = _list(weights.get('days'), '加权星期', 7)
        if not weighted_days:
            raise InvalidInput('星期权重至少选择一个星期。')
        for weekday in weighted_days:
            _num(weekday, '加权星期', 1, 7, True)
        if len(set(weighted_days)) != len(weighted_days):
            raise InvalidInput('加权星期不能重复。')
        percent = _num(weights.get('percent'), '所选星期合计百分比', 0, 100, True)
        if len(weighted_days) == 7 and percent != 100:
            raise InvalidInput('选择全部七天时，星期权重必须为 100%。')
    shift_ids = set()
    for shift in shifts:
        _obj(shift, '班次')
        sid = _str(shift.get('id'), '班次标识', 100)
        if sid == 'off' or sid in shift_ids:
            raise InvalidInput('班次标识重复或使用了保留值 off。')
        shift_ids.add(sid)
        if _clock(shift.get('start')) == _clock(shift.get('end')):
            raise InvalidInput('班次开始和结束时间不能相同。')
        _num(shift.get('required'), '每日班次人数', 0, MAX_EMPLOYEES, True)
        if shift.get('staffingMode', 'minimum') not in ('minimum', 'fixed'):
            raise InvalidInput('班次人数模式必须为 minimum（每日最少）或 fixed（每日固定）。')
    for key, label in (('nonConsecutiveShifts', '班次不相连'), ('weeklyShiftLimits', '周班次限制')):
        entries = _list(rules.get(key, []), label, MAX_SHIFTS)
        seen_ids, seen_shifts = set(), set()
        for entry in entries:
            _obj(entry, label)
            rule_id = _str(entry.get('id'), f'{label}规则标识', 64)
            if re.fullmatch(r'[A-Za-z0-9_-]+', rule_id) is None or rule_id in seen_ids:
                raise InvalidInput(f'{label}规则标识只能包含英文字母、数字、短横线和下划线，且不能重复。')
            sid = _str(entry.get('shiftId'), f'{label}班次标识', 100)
            if sid not in shift_ids or sid in seen_shifts:
                raise InvalidInput(f'{label}含不存在或重复的班次。')
            if key == 'weeklyShiftLimits':
                _num(entry.get('maxPerWeek'), '每人每周班次次数上限', 0, 7, True)
            seen_ids.add(rule_id)
            seen_shifts.add(sid)
    employee_ids = set()
    for emp in employees:
        _obj(emp, '员工')
        eid = _str(emp.get('id'), '员工标识', 100)
        if eid in employee_ids:
            raise InvalidInput('员工标识不能重复。')
        employee_ids.add(eid)
        maximum = _num(emp.get('maxHoursPerWeek'), '每周工时上限', 0, 168)
        minimum = _num(emp.get('minHoursPerWeek', 0), '每周最低工时', 0, 168)
        # minHoursPerMonth is a deprecated legacy field. Ignore it entirely,
        # including unresolved null defaults from older exported requests.
        if minimum > maximum or _minutes(minimum, ROUND_CEILING) > _minutes(maximum, ROUND_FLOOR):
            raise InvalidInput('每周最低工时不能超过每周工时上限（按整数分钟计算）。')
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
        group_budget += len(members) * max(1, len(selected) or len(shifts)) * horizon_length
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
    coverage = _obj(state.get('scheduleCoverage', {}), '排班确认范围')
    if len(coverage) > 3612:
        raise InvalidInput('排班确认月份过多。')
    for key, item in coverage.items():
        if not isinstance(key, str) or len(key) != 7:
            raise InvalidInput('排班确认月份必须为 YYYY-MM。')
        _date(key + '-01')
        _obj(item, '排班确认范围')
        ids = _list(item.get('employeeIds'), '已确认成员', MAX_EMPLOYEES)
        if any(not isinstance(eid, str) or eid not in employee_ids for eid in ids) or len(set(ids)) != len(ids):
            raise InvalidInput('排班确认范围含不存在或重复的成员。')
    options = _obj(request.get('options', {}), '求解选项')
    if 'referenceDate' in options:
        _date(options['referenceDate'])
    _num(options.get('timeLimitSeconds', 15), '求解时限', 0.01, 60)
    _num(options.get('seed', 1010), '随机种子', 0, 2147483647, True)
    if not isinstance(options.get('allowPartial', False), bool):
        raise InvalidInput('允许缺员选项必须为布尔值。')
    return state, dates, options


def solve(request: Any, on_solution_count: Callable[[int], None] | None = None) -> dict:
    began = time.monotonic()
    solution_counter = None
    boundary_context = None
    boundary_preview = []
    boundary_issues = []
    request_id = request.get('requestId', '') if isinstance(request, dict) else ''
    if not isinstance(request_id, str):
        request_id = ''

    def response(status, message, issues=None, assignments=None, solver=None, shortage=0, objective=None, bound=None):
        stats = {'wallTimeSeconds': round(time.monotonic() - began, 6), 'shortageCount': shortage, 'optimal': status == 'OPTIMAL',
                 'solutionCount': solution_counter.count if solution_counter is not None else 0}
        if objective is not None:
            stats['objectiveValue'] = objective
        if bound is not None:
            stats['bestBound'] = bound
        result = {'protocolVersion': 1, 'requestId': request_id, 'engine': ENGINE, 'status': status, 'issues': issues or [], 'stats': stats, 'message': message}
        if assignments is not None:
            result['assignments'] = assignments
            result['boundaryPreview'] = boundary_preview
            result['boundaryContext'] = boundary_context
            result['issues'].extend(boundary_issues)
            preview_counts = defaultdict(int)
            for record in assignments + boundary_preview:
                if record['shiftId'] != 'off':
                    preview_counts[(record['date'], record['shiftId'])] += 1
            for day in coverage_dates:
                if day in active:
                    continue
                date = dt.date.fromordinal(day).isoformat()
                for shift in shifts:
                    missing = shift['required'] - preview_counts[(date, shift['id'])]
                    if missing > 0:
                        result['issues'].append({'id': f'boundary-coverage-{date}-{shift["id"]}',
                            'type': 'boundary-coverage', 'severity': 'warning', 'date': date,
                            'message': f'{date} 的月外临时衔接安排中，{shift.get("name", shift["id"])}仍缺 {missing} 人；本次已允许缺员，临时安排未写入相邻月份。'})
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
        weekly_minimums = {e['id']: _minutes(e.get('minHoursPerWeek', 0), ROUND_CEILING) for e in employees}
        active = set(dates)
        month_start, month_end = dates[0] * DAY, (dates[-1] + 1) * DAY
        reference_day = _date(options.get('referenceDate', dt.date.today().isoformat()))
        first_week = dates[0] - dt.date.fromordinal(dates[0]).weekday()
        last_week = dates[-1] - dt.date.fromordinal(dates[-1]).weekday()
        planning_dates = list(range(first_week, last_week + 7))
        planning = set(planning_dates)
        week_dates = {week: list(range(week, week + 7)) for week in range(first_week, last_week + 1, 7)}
        fixed = [copy.deepcopy(a) for a in state['assignments'] if a['locked'] or _date(a['date']) not in active]
        existing_cells = {(a['employeeId'], _date(a['date'])) for a in fixed}
        confirmed = {month: set(item['employeeIds']) for month, item in state.get('scheduleCoverage', {}).items()}
        unknown_history = {eid: set() for eid in emap}
        variable_dates = {eid: set(dates) for eid in emap}
        known_blank_cells = set()
        incomplete = []
        for eid in emap:
            for day in planning_dates:
                if day in active or (eid, day) in existing_cells:
                    continue
                month_key = dt.date.fromordinal(day).strftime('%Y-%m')
                if eid in confirmed.get(month_key, set()):
                    known_blank_cells.add((eid, day))
                elif day >= reference_day:
                    variable_dates[eid].add(day)
                else:
                    unknown_history[eid].add(day)
            for week, days in week_dates.items():
                missing = sorted(unknown_history[eid].intersection(days))
                if missing:
                    incomplete.append({'employeeId': eid, 'weekStart': dt.date.fromordinal(week).isoformat(),
                                       'unknownDates': [dt.date.fromordinal(day).isoformat() for day in missing]})
        boundary_context = {'startDate': dt.date.fromordinal(first_week).isoformat(),
                            'endDate': dt.date.fromordinal(last_week + 6).isoformat(),
                            'referenceDate': dt.date.fromordinal(reference_day).isoformat(),
                            'incompleteHistory': incomplete}
        for item in incomplete:
            boundary_issues.append({'id': f'history-incomplete-{item["employeeId"]}-{item["weekStart"]}',
                'type': 'history-incomplete', 'severity': 'warning', 'employeeId': item['employeeId'], 'date': item['weekStart'],
                'message': f'{emap[item["employeeId"]].get("name", item["employeeId"])}在 {item["weekStart"]} 起的自然周有 {len(item["unknownDates"])} 天历史排班未知；没有将这些日期当作休息或补排。周最低仅按可核对天数折算，此周尚未通过完整周校验。'})
        # Unknown past cells cannot be invented. Team weekday counts require a
        # fully known/plannable day; individual known work still counts below.
        weighted_week_dates = {week: [day for day in days if not any(day in unknown_history[eid] for eid in emap)]
                               for week, days in week_dates.items()}
        coverage_dates = [day for day in planning_dates if day in active or day >= reference_day]
        coverage_active = set(coverage_dates)
        weights = state['rules'].get('weekdayWeights')
        non_consecutive_shifts = state['rules'].get('nonConsecutiveShifts', [])
        weekly_shift_limits = state['rules'].get('weeklyShiftLimits', [])
        allow_partial = options.get('allowPartial', False)
        weighted_weeks = {week: weekday_targets(weights, days, 0)[:2] for week, days in weighted_week_dates.items()} if weights else {}
        weekly_targets = {eid: {week: (minutes * (7 - len(unknown_history[eid].intersection(days))) + 6) // 7
                               for week, days in week_dates.items()} for eid, minutes in weekly_minimums.items()}
        # Records beyond this context are preserved, but unrelated historic
        # errors cannot make this month's generation infeasible. A full next
        # week is retained for Sunday's overnight upper-bound accounting.
        context_days = max(consecutive, (rest + DAY - 1) // DAY + 1, 7)
        relevant_fixed = [a for a in fixed if first_week - context_days <= _date(a['date']) <= last_week + 6 + context_days]
        fixed_cells = {}
        fixed_work = defaultdict(list)
        fixed_days = defaultdict(set)
        fixed_weeks = defaultdict(lambda: defaultdict(int))
        fixed_current_minutes = defaultdict(int)
        fixed_coverage = defaultdict(set)
        fixed_shift_days = defaultdict(set)
        fixed_weekly_shift_counts = defaultdict(int)
        fixed_relevant_weeks = {eid: set(week_dates) for eid in emap}
        conflicts = []
        for a in relevant_fixed:
            eid, sid, day = a['employeeId'], a['shiftId'], _date(a['date'])
            cell = (eid, day)
            if cell in fixed_cells and day in planning:
                conflicts.append(problem('duplicate', f'{a["date"]} {emap[eid].get("name", eid)}有多条固定排班（含锁定休息）。', '在排班日历保留该员工当天的一条安排，解除或删除重复固定记录。', 'calendar', date=a['date'], employeeId=eid))
            fixed_cells[cell] = a
            if sid == 'off':
                continue
            start_clock, duration = shift_times[sid]
            start, end = day * DAY + start_clock, day * DAY + start_clock + duration
            if day in planning and sid not in emap[eid]['eligibleShiftIds']:
                conflicts.append(problem('qualification', f'{a["date"]} {emap[eid].get("name", eid)}已固定上{smap[sid].get("name", sid)}，但该成员未勾选此班次资格。', '确认成员可上班次，或在排班日历解除/更换此固定安排；月外历史也会参与校验。', 'team', date=a['date'], employeeId=eid, shiftId=sid))
            overlapping_leave = [dt.date.fromordinal(x).isoformat() for x in range(start // DAY, (end - 1) // DAY + 1) if x in leave[eid]]
            if overlapping_leave and (day in planning or day + 1 in planning):
                conflicts.append(problem('unavailable', f'{a["date"]} {emap[eid].get("name", eid)}的固定{smap[sid].get("name", sid)}与 {"、".join(overlapping_leave)} 的整日请假重叠（包含跨夜部分）。', '核实请假日期，或解除/调整与请假重叠的固定班次。', 'team', date=a['date'], employeeId=eid, shiftId=sid))
            fixed_work[eid].append((start, end, a))
            fixed_days[eid].add(day)
            fixed_coverage[(day, sid)].add(eid)
            if day not in fixed_shift_days[(eid, sid)]:
                start_week = day - dt.date.fromordinal(day).weekday()
                fixed_weekly_shift_counts[(eid, start_week, sid)] += 1
                fixed_shift_days[(eid, sid)].add(day)
            for week, minutes in week_parts(start, end):
                fixed_weeks[eid][week] += minutes
                if day in planning:
                    fixed_relevant_weeks[eid].add(week)
            fixed_current_minutes[eid] += overlap_minutes(start, end, month_start, month_end)
        for eid, day in known_blank_cells:
            fixed_cells[(eid, day)] = {'employeeId': eid, 'date': dt.date.fromordinal(day).isoformat(), 'shiftId': 'off', 'locked': False}

        def weekly_requirement(eid, week):
            missing = len(unknown_history[eid].intersection(week_dates[week]))
            context = (f'有 {missing} 天历史未知，仅按其余 {7 - missing} 天折算，不能视为完整周通过；' if missing else
                       '按周一至周日完整自然周校验，合并相邻月份已确认安排与临时预排；')
            return context + f'周最低 {_hours_text(weekly_minimums[eid])} 小时，本周实际最低要求 {_hours_text(weekly_targets[eid][week])} 小时，已知固定工作 {_hours_text(fixed_weeks[eid][week])} 小时'

        for eid in emap:
            work = sorted(fixed_work[eid], key=lambda item: (item[0], item[1]))
            for previous, current in zip(work, work[1:]):
                if current[0] < previous[1] + rest and (_date(previous[2]['date']) in planning or _date(current[2]['date']) in planning):
                    interval = current[0] - previous[1]
                    gap = f'间隔仅 {_hours_text(interval)} 小时' if interval >= 0 else f'时间重叠 {_hours_text(-interval)} 小时'
                    conflicts.append(problem('rest', f'{emap[eid].get("name", eid)}的固定安排 {previous[2]["date"]} {smap[previous[2]["shiftId"]].get("name", previous[2]["shiftId"])} → {current[2]["date"]} {smap[current[2]["shiftId"]].get("name", current[2]["shiftId"])}，{gap}，要求至少休息 {_hours_text(rest)} 小时。', '调整这两次安排中的至少一次；先核对时间与锁定记录，确实允许更短休息时再修改休息规则。', 'calendar', employeeId=eid, date=current[2]['date']))
            for week, value in fixed_weeks[eid].items():
                if week in fixed_relevant_weeks[eid] and value > caps[eid]:
                    conflicts.append(problem('weekly-hours', f'{emap[eid].get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 起的自然周，固定安排已有 {_hours_text(value)} 小时，超过周上限 {_hours_text(caps[eid])} 小时（含跨月实际工时）。', f'至少减少该周 {_hours_text(value - caps[eid])} 小时的固定工作，或确认并调整成员周最高工时。', 'team', employeeId=eid, date=dt.date.fromordinal(week).isoformat()))
            run, last = 0, -10000
            for day in sorted(fixed_days[eid]):
                run = run + 1 if day == last + 1 else 1
                if (run == consecutive + 1 or day == first_week and run > consecutive) and day >= first_week and day - consecutive <= last_week + 6:
                    conflicts.append(problem('consecutive-days', f'{emap[eid].get("name", eid)}在 {dt.date.fromordinal(day - run + 1).isoformat()} 至 {dt.date.fromordinal(day).isoformat()} 已连续固定上班 {run} 天，上限为 {consecutive} 天。', '在这段连续安排中解除至少一天固定工作并安排休息，或核实连续工作日上限。', 'calendar', employeeId=eid, date=dt.date.fromordinal(day).isoformat()))
                last = day
            # Shift-count rules use calendar start dates, including an overnight
            # Sunday's shift in Sunday's week. They intentionally do not share
            # the actual-minute split used by weekly working-hour constraints.
            for rule in non_consecutive_shifts:
                sid = rule['shiftId']
                shift_days = fixed_shift_days[(eid, sid)]
                for day in sorted(shift_days):
                    if day + 1 not in shift_days or (day not in planning and day + 1 not in planning):
                        continue
                    first_date = dt.date.fromordinal(day).isoformat()
                    second_date = dt.date.fromordinal(day + 1).isoformat()
                    conflicts.append(problem('consecutive-shift',
                        f'{emap[eid].get("name", eid)}在 {first_date} 和 {second_date} 已固定上{smap[sid].get("name", sid)}，该班次不允许同一成员连续两天上班。',
                        '调整这两天中的至少一个固定班次，或核实班次不相连规则；相邻月份已有安排也计入，允许缺员不会放宽此规则。',
                        'rules', employeeId=eid, date=dt.date.fromordinal(max(day, dates[0])).isoformat(), shiftId=sid))
            for rule in weekly_shift_limits:
                sid, maximum = rule['shiftId'], int(rule['maxPerWeek'])
                for week in week_dates:
                    count = fixed_weekly_shift_counts[(eid, week, sid)]
                    if count > maximum:
                        conflicts.append(problem('weekly-shift-limit',
                            f'{emap[eid].get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 至 {dt.date.fromordinal(week + 6).isoformat()} 的自然周已固定上{smap[sid].get("name", sid)} {count} 次，超过每周最多 {maximum} 次（按班次开始日期计数，含跨月安排）。',
                            f'至少调整该周 {count - maximum} 次此班固定安排，或核实该班周次数上限；不足一周不折算，允许缺员不会放宽此规则。',
                            'rules', employeeId=eid, date=dt.date.fromordinal(max(week, dates[0])).isoformat(), shiftId=sid))
        for group in state['rules'].get('separationGroups', []):
            members = set(group['employeeIds'])
            selected = set(group['shiftIds']) or set(smap)
            for (day, sid), staff in fixed_coverage.items():
                overlap = staff & members
                if day in planning and sid in selected and len(overlap) > 1:
                    names = '、'.join(str(emap[eid].get('name', eid))[:80] for eid in sorted(overlap)[:5]) + (f'等 {len(overlap)} 人' if len(overlap) > 5 else '')
                    group_name = str(group.get('name', group['id']))[:120]
                    conflicts.append(problem('separation', f'{dt.date.fromordinal(day).isoformat()} {smap[sid].get("name", sid)}已固定安排 {names}，互斥组“{group_name}”要求他们同班最多 1 人。', '解除这些成员的同班锁定，或核对互斥分组的成员及适用班次。', 'rules', date=dt.date.fromordinal(day).isoformat(), shiftId=sid))
        for (day, sid), staff in fixed_coverage.items():
            if day in coverage_active and smap[sid].get('staffingMode', 'minimum') == 'fixed' and len(staff) > smap[sid]['required']:
                conflicts.append(problem('overstaffed', f'{dt.date.fromordinal(day).isoformat()} {smap[sid].get("name", sid)}固定排班有 {len(staff)} 人，超过每日固定人数 {smap[sid]["required"]}；允许缺员也不能突破固定人数上限。', f'解除至少 {len(staff) - smap[sid]["required"]} 人的该班锁定，或修改此班固定人数/人数模式。', 'calendar', date=dt.date.fromordinal(day).isoformat(), shiftId=sid))
        if conflicts:
            for index, item in enumerate(conflicts):
                item['id'] = f'{item["type"]}-{index}'
            return response('INFEASIBLE', '固定排班存在硬约束冲突，原排班未修改。', conflicts)
        check_time()
        model = cp_model.CpModel()
        diagnostics = ConstraintDiagnostics()
        x = {}
        cells = defaultdict(list)
        coverage = defaultdict(list)
        weekly = defaultdict(lambda: defaultdict(list))
        total_minutes = defaultdict(list)
        shift_counts = defaultdict(list)
        fixed_current_shifts = defaultdict(int)
        for e in employees:
            check_time()
            eid = e['id']
            intervals = []
            possible_weeks = dict(fixed_weeks[eid])
            for start, end, a in fixed_work[eid]:
                day = _date(a['date'])
                if day in active:
                    fixed_current_shifts[(eid, a['shiftId'])] += 1
            for day in sorted(variable_dates[eid]):
                if (eid, day) in fixed_cells:
                    continue
                day_week_maximums = defaultdict(int)
                for sid in e['eligibleShiftIds']:
                    if caps[eid] == 0:
                        continue
                    if smap[sid].get('staffingMode', 'minimum') == 'fixed' and len(fixed_coverage[(day, sid)]) >= smap[sid]['required']:
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
                    month_minutes = overlap_minutes(start, end, month_start, month_end)
                    total_minutes[eid].append(month_minutes * var)
                    if day in active:
                        shift_counts[(eid, sid)].append(var)
                    for week, minutes in parts:
                        weekly[eid][week].append(minutes * var)
                        day_week_maximums[week] = max(day_week_maximums[week], minutes)
                    intervals.append(model.new_optional_fixed_size_interval_var(start, duration + rest, var, f'i_{eid}_{day}_{sid}'))
                for week, minutes in day_week_maximums.items():
                    possible_weeks[week] = possible_weeks.get(week, 0) + minutes
                if cells[(eid, day)]:
                    model.add(sum(cells[(eid, day)]) <= 1)
            if intervals:
                model.add_no_overlap(intervals)
            for rule in non_consecutive_shifts:
                sid = rule['shiftId']
                for day in range(first_week - 1, last_week + 7):
                    terms = [x[(eid, candidate, sid)] for candidate in (day, day + 1) if (eid, candidate, sid) in x]
                    if not terms:
                        continue
                    prior = sum(candidate in fixed_shift_days[(eid, sid)] for candidate in (day, day + 1))
                    diagnostics.track(model.add(sum(terms) + prior <= 1), f'consecutive-shift-{eid}-{rule["id"]}-{day}', problem(
                        'consecutive-shift', f'{e.get("name", eid)}不能在 {dt.date.fromordinal(day).isoformat()} 和 {dt.date.fromordinal(day + 1).isoformat()} 连续上{smap[sid].get("name", sid)}；这两天已有 {prior} 次此班固定安排。',
                        '让其他成员分担相邻日期的此班需求，核对固定安排，或核实该班不相连规则。此条与同列要求组合冲突。',
                        'rules', employeeId=eid, date=dt.date.fromordinal(max(day, dates[0])).isoformat(), shiftId=sid))
            for rule in weekly_shift_limits:
                sid, maximum = rule['shiftId'], int(rule['maxPerWeek'])
                for week, days in week_dates.items():
                    terms = [x[(eid, day, sid)] for day in days if (eid, day, sid) in x]
                    if not terms:
                        continue
                    prior = fixed_weekly_shift_counts[(eid, week, sid)]
                    diagnostics.track(model.add(sum(terms) + prior <= maximum), f'weekly-shift-limit-{eid}-{rule["id"]}-{week}', problem(
                        'weekly-shift-limit', f'{e.get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 至 {dt.date.fromordinal(week + 6).isoformat()} 的自然周，{smap[sid].get("name", sid)}最多 {maximum} 次，已有固定安排 {prior} 次（按班次开始日期计数，含跨月安排；不足一周不折算）。',
                        '让其他成员分担该周此班需求，核对固定安排，或核实该班周次数上限。此条与同列要求组合冲突。',
                        'rules', employeeId=eid, date=dt.date.fromordinal(max(week, dates[0])).isoformat(), shiftId=sid))
            for week, terms in weekly[eid].items():
                diagnostics.track(model.add(sum(terms) + fixed_weeks[eid][week] <= caps[eid]), f'weekly-cap-{eid}-{week}', problem(
                    'weekly-hours', f'{e.get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 起的自然周最多 {_hours_text(caps[eid])} 小时，其中已有固定安排 {_hours_text(fixed_weeks[eid][week])} 小时（含跨月）。',
                    '核对该成员周最高工时及这周固定安排，或增加可分担班次的人员。此条与同列要求组合冲突。', 'team', employeeId=eid, date=dt.date.fromordinal(max(week, dates[0])).isoformat()))
            # Account for the whole week's cap, even if isolated candidates
            # would each fit. This remains an upper bound, not a promise that
            # rest/consecutive constraints allow all of these minutes.
            possible_weeks = {week: min(possible_weeks.get(week, 0), caps[eid]) for week in week_dates}
            for week, target in weekly_targets[eid].items():
                if possible_weeks.get(week, 0) < target:
                    conflicts.append(problem('weekly-min-hours', f'{e.get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 起的自然周，{weekly_requirement(eid, week)}，但现有班次、请假、固定安排和周上限下，整周最多不超过 {_hours_text(possible_weeks.get(week, 0))} 小时，至少相差 {_hours_text(target - possible_weeks.get(week, 0))} 小时。', '核对该成员这一周的可上班次、请假、相邻月份已确认安排及最低/最高工时；相邻月份固定记录不会自动改写。', 'team', employeeId=eid, date=dt.date.fromordinal(week).isoformat()))
                diagnostics.track(model.add(sum(weekly[eid][week]) + fixed_weeks[eid][week] >= target), f'weekly-min-{eid}-{week}', problem(
                    'weekly-min-hours', f'{e.get("name", eid)}在 {dt.date.fromordinal(week).isoformat()} 起的自然周，{weekly_requirement(eid, week)}。',
                    '核对该成员可用班次与固定安排，完整班次不能拆成零散小时；月外临时预排仅用于验证可衔接性。此条与同列要求组合冲突。', 'team', employeeId=eid, date=dt.date.fromordinal(max(week, dates[0])).isoformat()))
            for first_day in range(first_week - consecutive, last_week + 7):
                last_day = first_day + consecutive
                terms = [var for day in planning_dates if first_day <= day <= last_day for var in cells[(eid, day)]]
                prior = sum(first_day <= day <= last_day for day in fixed_days[eid])
                if terms:
                    diagnostics.track(model.add(sum(terms) + prior <= consecutive), f'consecutive-{eid}', problem(
                        'consecutive-days', f'{e.get("name", eid)}最多连续上班 {consecutive} 天；本月、相邻月份的固定记录与临时预排一并计入。',
                        '为该成员留出休息日、让其他成员分担连续日期的需求，或核实连续工作天数上限。此条与同列要求组合冲突。', 'rules', employeeId=eid))
        if conflicts:
            for index, item in enumerate(conflicts):
                item['id'] = f'{item["type"]}-{index}'
            return response('INFEASIBLE', '员工周最低工时无法达到，原排班未修改；允许缺员也不会放宽周最低工时。', conflicts)
        check_time()
        conflicts = daily_capacity_issues(employees, shifts, coverage_dates, x, fixed_coverage, fixed_cells, leave, shift_times, fixed_work, fixed_weeks, caps, rest, state['rules'].get('separationGroups', []), allow_partial, check_time)
        if not conflicts:
            conflicts = weekday_capacity_issues(weights, weighted_week_dates, employees, shifts, x, fixed_coverage, allow_partial, weekday_targets, check_time, coverage_active)
        if conflicts:
            for index, item in enumerate(conflicts):
                item['id'] = f'{item["type"]}-{index}'
                if item.get('date') and _date(item['date']) not in active and item['type'] != 'weekday-weight-capacity':
                    item['message'] += ' 这是相邻月份的衔接日期；已有确认安排保持不变，不能自动补写已确认的休息日。'
            return response('INFEASIBLE', '已定位无法满足的人员或星期人数要求，原排班未修改。', conflicts)
        # A conservative whole-week capacity proof, including confirmed work
        # and future boundary candidates. Unknown history contributes no made-up
        # work and its minimum has already been prorated per employee.
        if all(s.get('staffingMode', 'minimum') == 'fixed' for s in shifts):
            for week in week_dates:
                check_time()
                lower, upper = week * DAY, (week + 7) * DAY
                capacity = sum(fixed_weeks[eid][week] for eid in emap)
                for day in planning_dates:
                    for sid, (clock, duration) in shift_times.items():
                        candidates = sum((eid, day, sid) in x for eid in emap)
                        seats = min(candidates, max(0, smap[sid]['required'] - len(fixed_coverage[(day, sid)])))
                        capacity += seats * overlap_minutes(day * DAY + clock, day * DAY + clock + duration, lower, upper)
                minimum = sum(weekly_targets[eid][week] for eid in emap)
                if minimum > capacity:
                    return response('INFEASIBLE', '这一周的固定班次容量不足以满足成员最低工时，原排班未修改。', [problem(
                        'weekly-fixed-capacity', f'{dt.date.fromordinal(week).isoformat()} 起的自然周，成员最低工时要求合计 {_hours_text(minimum)} 小时，已确认工作及可预排固定班次最多提供 {_hours_text(capacity)} 小时，至少相差 {_hours_text(minimum - capacity)} 小时（按实际跨夜分钟计入）。',
                        '增加对应班次固定人数、将适合的班次改为每日最少人数，或核实成员的周最低工时及相邻月已确认安排。', 'shifts', date=dt.date.fromordinal(max(week, dates[0])).isoformat())])
        for group in state['rules'].get('separationGroups', []):
            check_time()
            member_names = [str(emap[eid].get('name', eid))[:80] for eid in group['employeeIds'][:5]]
            member_label = '、'.join(member_names) + (f'等 {len(group["employeeIds"])} 人' if len(group['employeeIds']) > 5 else '')
            group_label = f'互斥组“{str(group.get("name", group["id"]))[:120]}”（{member_label}）'
            for day in planning_dates:
                check_time()
                for sid in group['shiftIds'] or smap:
                    terms = [x[(eid, day, sid)] for eid in group['employeeIds'] if (eid, day, sid) in x]
                    prior = len(fixed_coverage[(day, sid)] & set(group['employeeIds']))
                    if terms:
                        diagnostics.track(model.add(sum(terms) + prior <= 1), f'separation-{group["id"]}-{day}-{sid}', problem(
                            'separation', f'{dt.date.fromordinal(day).isoformat()} {smap[sid].get("name", sid)}，{group_label}最多 1 人。',
                            '核对该互斥分组的成员与适用班次，或增加组外合格人员。此条与同列要求组合冲突。', 'rules', date=dt.date.fromordinal(day).isoformat(), shiftId=sid))
        current_shortages = []
        boundary_shortages = []
        for day in coverage_dates:
            for s in shifts:
                target = max(0, int(s['required']) - len(fixed_coverage[(day, s['id'])]))
                terms = coverage[(day, s['id'])]
                fixed_staffing = s.get('staffingMode', 'minimum') == 'fixed'
                boundary_note = (' 相邻月份衔接日期，已有确认安排不会自动改写。' if day not in active else '')
                detail = problem('coverage', f'{dt.date.fromordinal(day).isoformat()} {s.get("name", s["id"])}每日{"固定" if fixed_staffing else "最少"} {s["required"]} 人，其中已固定安排 {len(fixed_coverage[(day, s["id"])])} 人。' + (' 已允许缺员，但固定人数上限仍有效。' if allow_partial and fixed_staffing else '') + boundary_note,
                    '核对该班每日人数和人数模式，或增加当日符合资格、休息及工时要求的人员。此条与同列要求组合冲突。', 'shifts', date=dt.date.fromordinal(day).isoformat(), shiftId=s['id'])
                if allow_partial:
                    shortage = model.new_int_var(0, target, f'shortage_{day}_{s["id"]}')
                    if day in active:
                        current_shortages.append(shortage)
                    else:
                        boundary_shortages.append(shortage)
                    if fixed_staffing:
                        # A nonnegative exact shortfall keeps the fixed ceiling
                        # hard and provides a tighter linear model than max().
                        diagnostics.track(model.add(sum(terms) + shortage == target), f'coverage-{day}-{s["id"]}', detail)
                    else:
                        model.add_max_equality(shortage, [target - sum(terms), 0])
                elif fixed_staffing:
                    diagnostics.track(model.add(sum(terms) == target), f'coverage-{day}-{s["id"]}', detail)
                else:
                    diagnostics.track(model.add(sum(terms) >= target), f'coverage-{day}-{s["id"]}', detail)
        if weights:
            staff = len(employees)
            selected_count = len(weights['days'])
            other_count = 7 - selected_count
            for week, (selected, others) in weighted_weeks.items():
                context = ('完整自然周合并已确认记录与临时预排。' if len(weighted_week_dates[week]) == 7 else
                           '有未知历史的日期不视为零人，只对可核对日期按星期组比例折算；尚未通过完整周校验。')
                weight_detail = problem('weekday-weight', f'{dt.date.fromordinal(week).isoformat()} 起的自然周，星期 {"、".join(str(day) for day in weights["days"])} 合计占 {weights["percent"]}%（向上取整），其余星期平摊，组内每日人数相差不超过 1；' + context,
                    '核对该周的星期比例与每日人数要求、可用人员；调整比例或有关日期的人员/班次容量。此条与同列要求组合冲突。', 'rules', date=dt.date.fromordinal(max(week, dates[0])).isoformat())
                weight_key = f'weekday-weight-{week}'
                counts = {}
                for day in weighted_week_dates[week]:
                    count = model.new_int_var(0, len(employees), f'weekday_total_{day}')
                    fixed_count = sum(len(fixed_coverage[(day, sid)]) for sid in smap)
                    model.add(count == sum(var for sid in smap for var in coverage[(day, sid)]) + fixed_count)
                    counts[day] = count
                # Complete weeks use confirmed/temporary actual daily totals.
                # Unknown history retains a full-week basis for absent days.
                full_total = model.new_int_var(0, 7 * staff, f'full_week_total_{week}')
                full_selected = model.new_int_var(0, 7 * staff, f'full_week_selected_{week}')
                full_other = model.new_int_var(0, 7 * staff, f'full_week_other_{week}')
                model.add_division_equality(full_selected, full_total * int(weights['percent']) + 99, 100)
                model.add(full_other == full_total - full_selected)
                selected_target = model.new_int_var(0, len(selected) * staff, f'selected_target_{week}')
                other_target = model.new_int_var(0, len(others) * staff, f'other_target_{week}')
                model.add_division_equality(selected_target, full_selected * len(selected) + selected_count - 1, selected_count)
                if other_count:
                    model.add_division_equality(other_target, full_other * len(others) + other_count - 1, other_count)
                else:
                    model.add(other_target == 0)
                diagnostics.track(model.add(sum(counts[day] for day in selected) == selected_target), weight_key, weight_detail)
                diagnostics.track(model.add(sum(counts[day] for day in others) == other_target), weight_key, weight_detail)
                if len(weighted_week_dates[week]) == 7:
                    diagnostics.track(model.add(full_total == sum(counts.values())), weight_key, weight_detail)
                for label, group in (('selected', selected), ('remaining', others)):
                    if len(group) > 1:
                        low = model.new_int_var(0, len(employees), f'weekday_{week}_{label}_min')
                        high = model.new_int_var(0, len(employees), f'weekday_{week}_{label}_max')
                        model.add_min_equality(low, [counts[day] for day in group])
                        model.add_max_equality(high, [counts[day] for day in group])
                        diagnostics.track(model.add(high - low <= 1), weight_key, weight_detail)
        # Fairness is secondary: normalized workload and shift rotation.
        fairness_terms = []
        load_vars = []
        max_month_minutes = len(dates) * DAY
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
        fairness = sum(fairness_terms)
        check_time()
        error = model.validate()
        if error:
            return response('MODEL_INVALID', '求解模型无效，原排班未修改。', [issue('model-invalid', error[:1000])])
        # Reuse one tracker across coverage, staffing and fairness. A repeated
        # roster with different phase objectives/auxiliary variables counts once.
        solution_counter = SolutionCounter((var for (eid, day, sid), var in x.items() if day in active), on_solution_count)
        def run(limit):
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = max(0.001, limit)
            solver.parameters.num_search_workers = 2
            solver.parameters.random_seed = int(options.get('seed', 1010))
            solver.parameters.log_search_progress = False
            status = solver.solve(model, solution_counter)
            return solver, status
        def extract(solver):
            nonlocal boundary_preview
            boundary_preview = []
            result = copy.deepcopy(fixed)
            for (eid, day, sid), var in x.items():
                if solver.value(var):
                    record = {'employeeId': eid, 'date': dt.date.fromordinal(day).isoformat(), 'shiftId': sid, 'locked': False}
                    (result if day in active else boundary_preview).append(record)
            return sorted(result, key=lambda a: (a['date'], a['employeeId'], a['shiftId']))
        saved_assignments = None
        shortage_count = 0
        # Strict priorities: satisfy as much daily minimum coverage as explicitly
        # allowed, then avoid unnecessary assignments, then improve fairness.
        # Never add people simply to reduce a fairness score.
        phases = []
        if allow_partial:
            phases.append(('coverage', sum(current_shortages)))
            if boundary_shortages:
                phases.append(('boundary-coverage', sum(boundary_shortages)))
        phases.extend([('staffing', sum(x.values())), ('fairness', fairness)])
        status = cp_model.UNKNOWN
        for index, (phase, objective) in enumerate(phases):
            remaining = deadline - time.monotonic()
            if remaining <= 0.005:
                break
            model.minimize(objective)
            # Lower-priority phases only start after this objective is proved
            # optimal. Reserving time for them would waste budget if this stage
            # has not found a first feasible roster yet.
            solver, status = run(remaining)
            if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                break
            saved_assignments = extract(solver)
            shortage_count = sum(solver.value(var) for var in current_shortages)
            if status == cp_model.FEASIBLE:
                unresolved = {'coverage': '本月缺员数最少', 'boundary-coverage': '月外临时衔接缺员数最少', 'staffing': '班次总数最少', 'fairness': '公平性最优'}[phase]
                return _success(response, saved_assignments, 'FEASIBLE', state, shortage_count, solver.objective_value, solver.best_objective_bound,
                                f'已找到满足硬约束的可行排班；时限内尚未证明{unresolved}。')
            if index == len(phases) - 1:
                return _success(response, saved_assignments, 'OPTIMAL', state, shortage_count, solver.objective_value, solver.best_objective_bound)
            model.add(objective == round(solver.objective_value))
            model.clear_hints()
            for var in x.values():
                model.add_hint(var, solver.value(var))
        if saved_assignments is not None and status in (cp_model.UNKNOWN, cp_model.OPTIMAL):
            return _success(response, saved_assignments, 'FEASIBLE', state, shortage_count, None, None, '已保留满足全部硬约束的可行方案，后续班次数或公平轮班优化达到时限。')
        if status == cp_model.INFEASIBLE:
            try:
                details = diagnostics.explain(model, deadline, int(options.get('seed', 1010)), _hours_text(rest))
            except Exception:
                # A failure to explain a completed proof must never erase it or
                # turn into UNKNOWN / ERROR; no replacement roster is returned.
                details = [problem('diagnosis-incomplete', '求解器已证明无解，但进一步定位冲突时未能完成诊断。', '请导出本次规则用于复现排查；当前结果尚不能归因于某一项设置。', 'rules')]
            return response('INFEASIBLE', '已确认当前配置无法排班，具体冲突与调整方向见下方；原排班未修改。', details)
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
    dates = [first + dt.timedelta(days=day) for day in range(calendar.monthrange(first.year, first.month)[1])]
    for date in dates:
        for shift in state['shifts']:
            missing = shift['required'] - coverage[(date.isoformat(), shift['id'])]
            if missing > 0:
                mode = '固定' if shift.get('staffingMode', 'minimum') == 'fixed' else '最少'
                shortages.append({'id': f'coverage-{date}-{shift["id"]}', 'type': 'coverage', 'severity': 'warning', 'date': date.isoformat(), 'message': f'{date.isoformat()} {shift.get("name", shift["id"])}比每日{mode}人数缺 {missing} 人。'})
    if message is None:
        message = '已找到最优排班方案。' if status == 'OPTIMAL' else '已找到可行排班方案；时限内尚未证明公平性最优。'
        if shortage:
            message += f' 已明确允许缺员，本月仍缺 {shortage} 个班次人次。'
    return response(status, message, shortages, assignments, shortage=shortage, objective=objective, bound=bound)
