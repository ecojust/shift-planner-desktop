import type { Issue } from './domain.ts'

const guidance: Record<string, { target: NonNullable<Issue['target']>; suggestion: string }> = {
  'monthly-min-hours': { target: 'team', suggestion: '查看该成员的月最低工时、可上班次和请假日期；如需保留最低工时，请增加实际可安排的班位。' },
  'weekly-min-hours': { target: 'team', suggestion: '核对该自然周的已知跨月安排、请假和可上班次；本月最低要求取按天折算值与整周剩余缺口的较小值，周最高仍计算整周工时。' },
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
  'weekday-weight': { target: 'rules', suggestion: '核对上班权重与每日班次人数；星期占比和班次人数要求必须同时满足。' },
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
