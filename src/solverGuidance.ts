import type { Issue, PlannerState } from './domain.ts'
import { getWeekBoundaryContext } from './weekBoundary.ts'

type BoundaryNoticeState = Pick<PlannerState, 'month' | 'employees' | 'assignments' | 'scheduleCoverage' | 'provenance'>
export type BoundaryNoticeKind = 'known' | 'preview' | 'unknown' | 'invalid'
export interface BoundaryWeekNoticeInfo {
  edge: 'start' | 'end'
  label: string
  weekStart: string
  weekEnd: string
  adjacentMonth: string
  items: Array<{ kind: BoundaryNoticeKind; label: string; description: string }>
}

/** Describe the same member-by-member evidence used by the solver. A single
 * saved cell must never make another member's missing history look complete. */
export function boundaryWeekNotices(state: BoundaryNoticeState, referenceDate?: string): BoundaryWeekNoticeInfo[] {
  const context = getWeekBoundaryContext(state, { referenceDate })
  if (!context || !state.employees.length) return []
  return context.weeks.filter(week => week.outsideDates.length).map(week => {
    const edge = week.outsideDates[0]! < `${state.month}-01` ? 'start' : 'end'
    const adjacent = edge === 'start' ? '上月' : '下月'
    const adjacentMonth = week.outsideDates[0]!.slice(0, 7)
    const known = week.employees.some(employee => employee.knownDates.length > 0)
    const unknown = week.employees.filter(employee => employee.unknownPastDates.length > 0)
    const preview = week.employees.some(employee => employee.unknownFutureDates.length > 0)
    const items: BoundaryWeekNoticeInfo['items'] = []
    if (known) items.push({ kind: 'known', label: `已计入${adjacent}排班`, description: '已有工作与排班休息固定保留。' })
    if (known && state.provenance?.invalidatedSchedules?.[adjacentMonth]) {
      items.push({ kind: 'invalid', label: `${adjacent}配置已修改`, description: '按已有排班和当前配置检查跨月周，发现冲突时再调整。' })
    }
    if (unknown.length) items.push({ kind: 'unknown', label: '历史待核对', description: `${unknown.length} 位成员的月外历史不完整，未知空白不视为休息，整周规则仍待核对。` })
    if (preview) items.push({ kind: 'preview', label: '未来未排 · 临时预排', description: '为月外未来空白试排，检查本周能否衔接；不保存到相邻月份。' })
    return { edge, label: edge === 'start' ? '月初周' : '月末周', weekStart: week.weekStart, weekEnd: week.weekEnd, adjacentMonth, items }
  })
}

/** Compatibility for callers migrating from the former opening-week text. */
export function openingWeekNotice(state: BoundaryNoticeState, referenceDate?: string) {
  const weeks = boundaryWeekNotices(state, referenceDate)
  if (!weeks.length) return null
  const summary = weeks.map(week => `${week.label}：${week.items.map(item => item.label).join('；')}。`).join('')
  return {
    included: weeks.some(week => week.items.some(item => item.kind === 'known')),
    title: '按完整自然周衔接上下月',
    range: weeks.map(week => `${week.weekStart}（周一）— ${week.weekEnd}（周日）`).join('；'),
    summary: `${summary}只保存本月，相邻月已有记录保持不变。`,
    hours: '周最低与最高按自然周检查；未来未排日期临时预排，未知历史不当作休息，整周结果待核对。',
    weights: '星期权重结合相邻月已知排班与未来临时预排检查；缺少历史时保留待核对提示。',
  }
}

const guidance: Record<string, { target: NonNullable<Issue['target']>; suggestion: string }> = {
  'weekly-min-hours': { target: 'team', suggestion: '核对该自然周的上下月排班、请假和可上班次。已知月外工时计入整周最低，未来空白临时预排；历史不完整时先补齐真实记录，不能用虚构班次抵扣。' },
  'weekly-hours': { target: 'team', suggestion: '查看成员的周最高工时及该自然周的跨月安排，调整超出的班次。' },
  qualification: { target: 'team', suggestion: '在成员的“可上班次”中核对资格，或调整对应的锁定安排。' },
  unavailable: { target: 'team', suggestion: '核对该成员的请假日历；跨夜班也不能进入请假日期。' },
  coverage: { target: 'shifts', suggestion: '查看该班人数要求，并补充可上该班的成员。' },
  overstaffed: { target: 'shifts', suggestion: '减少该日锁定人数，或修改班次的每日固定人数。' },
  rest: { target: 'calendar', suggestion: '查看相邻班次的开始、结束时间，移动冲突安排以留足休息时间。' },
  duplicate: { target: 'calendar', suggestion: '同一成员同一天只能保留一个安排，请检查对应日期。' },
  'consecutive-days': { target: 'calendar', suggestion: '在连续工作期间安排休息日，并核对相邻月份的排班。' },
  'consecutive-shift': { target: 'rules', suggestion: '查看该班次的“不相连”规则，将连续两天中的一天改为其他班次或休息；同时核对相邻月份的安排。' },
  'weekly-shift-limit': { target: 'rules', suggestion: '核对该成员周一至周日的此班次次数（含已知跨月安排），减少超出安排，或调整周班次上限。' },
  separation: { target: 'rules', suggestion: '查看同班互斥分组，将冲突成员错开日期或班次。' },
  'weekday-weight': { target: 'rules', suggestion: '核对上班权重与每日班次人数。月初和月末均结合相邻月已知排班检查；相邻记录保持不变，冲突时需调整对应月份的安排或规则。' },
  'weekday-quota': { target: 'rules', suggestion: '核对所选星期占比及每日人数；跨月周计入相邻月已知安排，并试排未来空白。已有记录不会自动改动，历史不完整时需核对后才能确认整周。' },
  'weekday-balance': { target: 'rules', suggestion: '同组星期每天的安排人数最多相差 1 班。跨月周的相邻月已知日期也参与比较；请核对对应月份的安排或调整规则。' },
  'boundary-history-incomplete': { target: 'calendar', suggestion: '补齐对应成员的真实历史工作或休息记录，再检查跨月自然周；未知历史不会自动当作休息。' },
  'history-incomplete': { target: 'calendar', suggestion: '补齐对应成员的真实历史工作或休息记录，再检查跨月自然周；未知历史不会自动当作休息。' },
  'boundary-future-unconfirmed': { target: 'calendar', suggestion: '生成相邻月份后再次检查这个自然周；临时预排仅用于本次求解，尚未保存为相邻月排班。' },
}

/** Browser candidate warnings remain candidate warnings; this only adds a route to edit them. */
export function withSolverGuidance(issues: Issue[]): Issue[] {
  return issues.map(issue => {
    const defaults = guidance[issue.type]
    return { ...issue, suggestion: issue.suggestion || defaults?.suggestion, target: issue.target || defaults?.target }
  })
}

export function diagnosticActionLabel(issue: Issue): string {
  switch (issue.target) {
    case 'team': return '查看成员设置'
    case 'shifts': return '查看班次设置'
    case 'rules': return '查看排班规则'
    case 'calendar': return issue.date ? '查看对应日期' : '查看排班日历'
    default: return ''
  }
}
