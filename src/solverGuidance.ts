import type { Issue, PlannerState } from './domain.ts'
import { getPreviousWeekContext } from './weekBoundary.ts'

/** Keep generation and configuration explanations aligned with the carry-in rule. */
export function openingWeekNotice(state: Pick<PlannerState, 'month' | 'employees' | 'assignments'>) {
  const previous = getPreviousWeekContext(state)
  if (previous) return {
    included: true,
    title: '已计入上月排班',
    range: `${previous.weekStart}（周一）— ${previous.weekEnd}（周日）`,
    summary: '本月首周与上月同一自然周合并计算周工时、周班次次数和已启用的星期权重。只重新安排本月，上月记录保持不变。',
    hours: '本月须补足整周最低工时扣除上月已排工时后的剩余缺口，不再按本月天数封顶；周最高仍计算完整自然周。',
    weights: '按上月已排与本月实际总班数一起计算星期占比和组内每天的人数分布；上月记录固定保留。',
  }
  const first = new Date(`${state.month}-01T00:00:00Z`)
  if (!Number.isFinite(first.getTime()) || first.getUTCDay() === 1) return null
  return {
    included: false,
    title: '月初周按当月部分折算',
    range: '',
    summary: '暂无当前成员的上月排班记录。月初周最低工时按本月天数折算，星期权重保留本月出现的星期份额。',
    hours: '暂无当前成员的上月排班记录，月初周最低工时按本月所占天数折算；周最高仍计算已知跨月工时。',
    weights: '暂无当前成员的上月排班记录，月初只保留本月出现的星期份额；缺失星期的份额不重新分配。',
  }
}

const guidance: Record<string, { target: NonNullable<Issue['target']>; suggestion: string }> = {
  'monthly-min-hours': { target: 'team', suggestion: '查看该成员的月最低工时、可上班次和请假日期；如需保留最低工时，请增加实际可安排的班位。' },
  'weekly-min-hours': { target: 'team', suggestion: '核对该自然周的跨月排班、请假和可上班次。已计入上月排班的月初周须补足整周最低工时；无上月记录及月末部分周仍按本月天数折算，并考虑已知月外工时。' },
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
  'weekday-weight': { target: 'rules', suggestion: '核对上班权重与每日班次人数。已计入上月排班的月初周按整周占比和每天人数分布检查；上月记录保持不变，冲突时需调整上月安排或规则。' },
  'weekday-quota': { target: 'rules', suggestion: '核对所选星期占比及每日人数；月初已接入上月排班时，整周总班数包含上月已排。上月记录不会自动改动，请按需调整历史安排或权重。' },
  'weekday-balance': { target: 'rules', suggestion: '同组星期每天的安排人数最多相差 1 班。月初已接入上月排班时，上月各天人数也参与比较；请核对上月安排或调整规则。' },
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
