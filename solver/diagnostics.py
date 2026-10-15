"""Proof-based, bounded explanations. Never alters the model used for scheduling."""
from __future__ import annotations

import datetime as dt
import time
from collections import defaultdict

from ortools.sat.python import cp_model


def day_text(day):
    return dt.date.fromordinal(day).isoformat()


def hours(minutes):
    return f'{minutes / 60:.2f}'.rstrip('0').rstrip('.')


def problem(kind, message, suggestion, target, **context):
    # A display label must not multiply an oversized imported name into a huge
    # diagnostic payload. The exported request retains the complete source data.
    if len(message) > 2400:
        message = message[:2400] + '…（内容过长已省略，请通过导出规则查看完整数据。）'
    if len(suggestion) > 1200:
        suggestion = suggestion[:1200] + '…'
    return {'id': kind, 'type': kind, 'severity': 'error', 'message': message,
            'suggestion': suggestion, 'target': target, **context}


class ConstraintDiagnostics:
    def __init__(self):
        self.groups = {}

    def track(self, constraint, key, detail):
        group = self.groups.setdefault(key, {'indices': [], 'issue': detail})
        group['indices'].append(constraint.index)
        return constraint

    def explain(self, model, deadline, seed, rest_hours):
        """Use only the original request's remaining budget after proven infeasible.

        Only linear constraints are guarded in the diagnostic copy. Candidate
        pruning, one-shift-per-day, rest intervals and auxiliary definitions stay
        in force; a core is a sufficient combination against that fixed background.
        It must never be described as the unique cause or a minimal repair.
        """
        fallback = problem('diagnosis-incomplete',
            '求解器已证明无解，但本次剩余时限不足以定位具体的冲突组合。',
            '增加求解时限后重试，或导出本次规则用于复现排查；不要据此随意降低工时或人数要求。', 'rules')
        remaining = deadline - time.monotonic()
        if remaining < 0.03 or not self.groups:
            return [fallback]
        diagnostic = model.clone()
        diagnostic.clear_objective()
        diagnostic.clear_hints()
        indexed = {}
        for key, group in self.groups.items():
            if time.monotonic() >= deadline - 0.01:
                return [fallback]
            flag = diagnostic.new_bool_var(f'diagnose_{key}')
            for index in group['indices']:
                # Guard only linear constraints, never intervals / divisions.
                constraint = diagnostic.proto.constraints[index]
                if not constraint.HasField('linear'):
                    raise ValueError('Diagnostic constraint must be linear')
                constraint.enforcement_literal.append(flag.index)
            diagnostic.add_assumption(flag)
            indexed[flag.index] = group['issue']
        remaining = deadline - time.monotonic()
        if remaining < 0.01:
            return [fallback]
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = min(2.0, remaining)
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = seed
        status = solver.solve(diagnostic)
        if status != cp_model.INFEASIBLE:
            return [problem('diagnosis-incomplete', '求解器已证明无解，但本次限时冲突分析尚未定位到具体组合。', '可增加求解时限重试；复杂组合仍未定位时，请导出本次规则用于复现排查。', 'rules')]
        core = solver.sufficient_assumptions_for_infeasibility()
        core = [index for index in core if index in indexed]
        details = [dict(indexed[index]) for index in core[:100]]
        if not details:
            return [problem('diagnosis-background',
                '冲突存在于固定安排或候选班次的基础限制中，尚未定位到可单独列出的规则组合。',
                '导出本次规则进一步复现；当前结果不能据此认定某一条工时或人数设置错误。', 'calendar')]
        # This is a sufficient set, not necessarily the only or smallest set.
        intro = problem('constraint-combination',
            f'已定位一组不能同时满足的具体要求，见下列条目。此组合是在现有资格、请假、固定安排和周上限筛选出的可用班次内，遵守每日一班及最短休息 {rest_hours} 小时后确认的。',
            '优先核对下列人员、日期及数值，调整后重新求解；不代表每条要求都要修改，也不保证只改一条即可成功。', 'rules')
        if len(core) > len(details):
            intro['message'] = f'已确认的冲突组合共有 {len(core)} 项，下面仅展示前 {len(details)} 项，不是完整组合；不能根据这部分排除未展示规则的影响。诊断已同时计入资格、请假、固定安排、周上限筛选、每日一班及最短休息 {rest_hours} 小时的限制。'
            intro['suggestion'] = '请导出本次规则复现完整冲突；下列条目可先核对，但不能据此认定只修改其中一条即可解决。'
        for index, item in enumerate(details):
            item['id'] = f'conflict-{index}-{item["type"]}'
        return [intro, *details]


def daily_capacity_issues(employees, shifts, dates, x, fixed_coverage, fixed_cells,
                          leave, shift_times, fixed_work, fixed_weeks, caps, rest,
                          groups, allow_partial, check_time):
    """Necessary daily conditions, including Hall competition for shared staff."""
    if allow_partial:
        return []
    emap = {e['id']: e for e in employees}
    smap = {s['id']: s for s in shifts}
    result = []

    def names(ids):
        ordered = [str(emap[eid].get('name', eid))[:80] for eid in sorted(ids)]
        return '、'.join(ordered[:5]) + (f'等 {len(ordered)} 人' if len(ordered) > 5 else '')

    def exclusion_details(day, sid):
        counts = defaultdict(list)
        for e in employees:
            eid = e['id']
            if eid in fixed_coverage[(day, sid)] or (eid, day, sid) in x:
                continue
            if sid not in e['eligibleShiftIds']:
                reason = '未勾选该班次资格'
            elif (eid, day) in fixed_cells:
                a = fixed_cells[(eid, day)]
                reason = ('已锁定休息' if a['locked'] else '相邻月份已确认休息') if a['shiftId'] == 'off' else '已有其他固定班次'
            else:
                clock, duration = shift_times[sid]
                start, end = day * 1440 + clock, day * 1440 + clock + duration
                if any(d in leave[eid] for d in range(start // 1440, (end - 1) // 1440 + 1)):
                    reason = '请假与班次时间重叠（含跨夜）'
                elif any(start < end2 + rest and start2 < end + rest for start2, end2, _ in fixed_work[eid]):
                    reason = f'与固定安排间隔不足 {hours(rest)} 小时'
                else:
                    reason = f'周上限 {hours(caps[eid])} 小时无法再容纳该班次'
            counts[reason].append(eid)
        return '；'.join(f'{names(ids)}：{reason}' for reason, ids in counts.items())

    for day in dates:
        check_time()
        date = day_text(day)
        candidates = {s['id']: [e['id'] for e in employees if (e['id'], day, s['id']) in x] for s in shifts}
        remaining = {s['id']: max(0, s['required'] - len(fixed_coverage[(day, s['id'])])) for s in shifts}
        specific = []
        for s in shifts:
            sid = s['id']
            available = len(candidates[sid]) + len(fixed_coverage[(day, sid)])
            if available < s['required']:
                reasons = exclusion_details(day, sid)
                specific.append(problem('coverage-capacity',
                    f'{date} {s.get("name", sid)}需要 {s["required"]} 人，现有条件下最多 {available} 人，还缺 {s["required"] - available} 人。' + (f' 原因：{reasons}。' if reasons else ''),
                    f'在成员管理中核对该日请假、可上班次与工时上限，增加可上此班的成员，或调整此班每日人数；若允许缺员，可启用后重新求解。',
                    'team', date=date, shiftId=sid))
            for group in groups:
                if group['shiftIds'] and sid not in group['shiftIds']:
                    continue
                members = set(group['employeeIds'])
                prior = fixed_coverage[(day, sid)]
                grouped = set(candidates[sid]) & members
                upper = len(prior) + len(set(candidates[sid]) - members) + min(len(grouped), max(0, 1 - len(prior & members)))
                if upper < s['required'] and available >= s['required']:
                    specific.append(problem('separation-capacity',
                        f'{date} {s.get("name", sid)}需要 {s["required"]} 人，但互斥组“{group.get("name", group["id"])}”（{names(grouped | (prior & members))}）同班最多 1 人，合计最多可安排 {upper} 人。',
                        '增加不受该互斥组限制的合格成员，或核对该组成员及适用班次；若业务允许，也可调整该班人数。',
                        'rules', date=date, shiftId=sid))
        if specific:
            result.extend(specific)
            # A representative date with exact values is more useful than 31 copies.
            break
        # Bipartite matching: distinct available employees must cover all slots.
        # Ignoring cross-day/rest/separation constraints is a relaxation, so a
        # failed matching rigorously proves the actual daily requirements impossible.
        slots = [sid for s in shifts for sid in [s['id']] * remaining[s['id']]]
        if not slots:
            continue
        matched = {}
        slot_employee = {}

        def augment(slot, seen):
            for eid in candidates[slots[slot]]:
                if eid in seen:
                    continue
                seen.add(eid)
                if eid not in matched or augment(matched[eid], seen):
                    matched[eid] = slot
                    slot_employee[slot] = eid
                    return True
            return False

        for slot in range(len(slots)):
            check_time()
            augment(slot, set())
        if len(matched) < len(slots):
            # Alternating reachability gives a deficient subset (Hall witness),
            # rather than incorrectly blaming unrelated shifts or the whole team.
            reachable_slots = {slot for slot in range(len(slots)) if slot not in slot_employee}
            reachable_people = set()
            pending = list(reachable_slots)
            while pending:
                slot = pending.pop()
                for eid in candidates[slots[slot]]:
                    if eid not in reachable_people:
                        reachable_people.add(eid)
                        if eid in matched and matched[eid] not in reachable_slots:
                            reachable_slots.add(matched[eid])
                            pending.append(matched[eid])
            involved = sorted({slots[slot] for slot in reachable_slots})
            labels = '、'.join(smap[sid].get('name', sid) for sid in involved)
            result.append(problem('daily-shared-capacity',
                f'{date} 的 {labels}还需填 {len(reachable_slots)} 个班次名额，但能覆盖这些名额的不同成员仅 {len(reachable_people)} 人（{names(sorted(reachable_people)) or "无"}）；每人每日只能上一个班。',
                f'至少增加 {len(reachable_slots) - len(reachable_people)} 名能上这些班次的成员，或扩展其他成员的可上班次、调整该日固定安排/人数要求。',
                'team', date=date))
            break
    return result


def weekday_capacity_issues(weights, week_dates, employees, shifts, x, fixed_coverage, allow_partial, targets, check_time, active_dates):
    if not weights:
        return []
    staff = len(employees)
    for week, days in week_dates.items():
        check_time()
        bounds = {}
        for day in days:
            fixed_count = sum(len(fixed_coverage[(day, s['id'])]) for s in shifts)
            if day not in active_dates:
                # Only explicitly known historical days reach this helper.
                # Today's required staffing must not rewrite their counts.
                bounds[day] = fixed_count, fixed_count
                continue
            eligible = {e['id'] for e in employees for s in shifts if (e['id'], day, s['id']) in x}
            lower = fixed_count if allow_partial else sum(max(len(fixed_coverage[(day, s['id'])]), s['required']) for s in shifts)
            upper = fixed_count + len(eligible)
            if all(s.get('staffingMode', 'minimum') == 'fixed' for s in shifts):
                upper = min(upper, sum(s['required'] for s in shifts))
            bounds[day] = lower, upper

        def fits(group, total):
            if not group:
                return total == 0
            low, remainder = divmod(total, len(group))
            high = low + (1 if remainder else 0)
            # Balance rule limits daily totals to floor/ceil(group mean).
            return all(max(a, low) <= min(b, high) for a, b in (bounds[d] for d in group)) and sum(max(bounds[d][0], low) for d in group) <= total <= sum(min(bounds[d][1], high) for d in group)

        viable = False
        for full_total in range(7 * staff + 1):
            if full_total % 64 == 0:
                check_time()
            selected, other, selected_target, other_target = targets(weights, days, full_total)
            if fits(selected, selected_target) and fits(other, other_target) and (len(days) != 7 or selected_target + other_target == full_total):
                viable = True
                break
        if not viable:
            labels = '、'.join(str(d) for d in weights['days'])
            detail = '；'.join(f'{day_text(day)[5:]}：{a} 人' if a == b else f'{day_text(day)[5:]}：{a}–{b} 人' for day, (a, b) in bounds.items())
            context = ('完整自然周合并已确认记录与临时预排。' if len(days) == 7 else
                       '未知历史日期不视为休息，仅对可核对日期按星期组比例折算。')
            return [problem('weekday-weight-capacity',
                f'{day_text(week)} 起这一周，星期 {labels} 合计 {weights["percent"]}%（向上取整、组内均摊）的要求与每日人数范围冲突。当前可行范围：{detail}。' + context,
                '调整所选星期或百分比，或调整相关班次固定/最少人数、人员可用日期；当前每天的人数范围内不存在满足此比例的组合。',
                'rules', date=day_text(min((day for day in days if day in active_dates), default=min(days))))]
    return []
