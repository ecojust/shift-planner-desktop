import type { Issue, PlannerState } from './domain.ts'
import { validateSchedule } from './scheduler.ts'
import { schedulingReferenceDate, type BoundaryOptions } from './weekBoundary.ts'

export type ScheduleCheckStatus = 'compliant' | 'noncompliant' | 'pending'

export interface ScheduleCheckResult {
  month: string
  status: ScheduleCheckStatus
  issues: Issue[]
  checkedAt: string
}

/** Missing staffing is a failed rule even though the validator labels it a
 * warning for partial generation. Unknown neighbouring dates remain pending. */
export function classifyScheduleIssues(issues: readonly Issue[]): ScheduleCheckStatus {
  if (issues.some(issue => issue.severity === 'error' || issue.type === 'coverage' || issue.type === 'boundary-coverage')) return 'noncompliant'
  return issues.length ? 'pending' : 'compliant'
}

/** Recheck the saved roster independently of any solver success or preview. */
export function checkSchedule(state: PlannerState, options: BoundaryOptions = {}): ScheduleCheckResult {
  const referenceDate = options.referenceDate ?? schedulingReferenceDate()
  const issues = validateSchedule(state, { referenceDate })
  return { month: state.month, status: classifyScheduleIssues(issues), issues, checkedAt: new Date().toISOString() }
}

/** Vue proxies cannot be structured-cloned. Strip only profile photos, keeping
 * historical rosters, completeness metadata and every rule in the snapshot. */
export function scheduleCheckSnapshot(state: PlannerState): PlannerState {
  const employees = state.employees.map(({ avatar: _avatar, ...employee }) => employee)
  return JSON.parse(JSON.stringify({ ...state, employees }, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('规则中包含无效数字，请检查工时和人数设置。')
    return value
  })) as PlannerState
}

export interface ScheduleCheckRequest {
  requestId: string
  month: string
  referenceDate: string
  state: PlannerState
}

export type ScheduleCheckResponse =
  | { requestId: string; month: string; result: ScheduleCheckResult }
  | { requestId: string; month: string; error: string }
