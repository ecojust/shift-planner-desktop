import type { PlannerState } from './domain.ts'
import { classifyScheduleIssues, scheduleCheckSnapshot, type ScheduleCheckRequest, type ScheduleCheckResult } from './scheduleCheck.ts'
import { schedulingReferenceDate } from './weekBoundary.ts'

export type ScheduleCheckEvent =
  | { status: 'checking'; month: string }
  | { status: 'ready'; month: string; result: ScheduleCheckResult }
  | { status: 'error'; month: string; message: string }

export type ScheduleCheckWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>

export interface ScheduleCheckRunnerOptions {
  createWorker: () => ScheduleCheckWorker
  onChange: (event: ScheduleCheckEvent) => void
  timeoutMs?: number
}

export interface ScheduleCheckRunner {
  start: (state: PlannerState) => void
  cancel: () => void
  dispose: () => void
}

interface ActiveCheck {
  requestId: string
  month: string
  worker?: ScheduleCheckWorker
  timer?: ReturnType<typeof setTimeout>
}

let requestSequence = 0

function isCheckResult(value: unknown, month: string): value is ScheduleCheckResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ScheduleCheckResult>
  return result.month === month
    && ['compliant', 'noncompliant', 'pending'].includes(result.status ?? '')
    && typeof result.checkedAt === 'string' && Number.isFinite(Date.parse(result.checkedAt))
    && Array.isArray(result.issues) && result.issues.every(issue => issue && typeof issue === 'object'
      && typeof issue.id === 'string' && typeof issue.type === 'string' && typeof issue.message === 'string'
      && (issue.severity === 'error' || issue.severity === 'warning'))
    && classifyScheduleIssues(result.issues) === result.status
}

/** Each run owns a worker. Replacing a run cancels its CPU work as well as its
 * callbacks; request and month checks also guard messages already in flight. */
export function createScheduleCheckRunner(options: ScheduleCheckRunnerOptions): ScheduleCheckRunner {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('规则检查超时时间必须大于零。')
  let active: ActiveCheck | undefined
  let disposed = false

  const cleanup = (check: ActiveCheck) => {
    if (check.timer !== undefined) clearTimeout(check.timer)
    if (check.worker) {
      check.worker.onmessage = null
      check.worker.onerror = null
      check.worker.onmessageerror = null
      check.worker.terminate()
    }
  }
  const cancel = () => {
    const check = active
    active = undefined
    if (check) cleanup(check)
  }
  const fail = (check: ActiveCheck, message: string) => {
    if (active !== check || disposed) return
    active = undefined
    cleanup(check)
    options.onChange({ status: 'error', month: check.month, message })
  }

  const start = (state: PlannerState) => {
    if (disposed) return
    cancel()
    const check: ActiveCheck = { requestId: `schedule-check-${++requestSequence}`, month: state.month }
    active = check
    const referenceDate = schedulingReferenceDate()
    options.onChange({ status: 'checking', month: check.month })
    if (active !== check || disposed) return
    let snapshot: PlannerState
    try {
      snapshot = scheduleCheckSnapshot(state)
    } catch (error) {
      fail(check, error instanceof Error ? error.message : '无法读取排班数据，请重试。')
      return
    }
    check.timer = setTimeout(() => fail(check, '规则检查超时，请重试。'), timeoutMs)
    queueMicrotask(() => {
      if (active !== check || disposed) return
      try {
        const worker = options.createWorker()
        check.worker = worker
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (active !== check || disposed || !event.data || typeof event.data !== 'object') return
          const response = event.data as Record<string, unknown>
          if (response.requestId !== check.requestId || response.month !== check.month) return
          if (typeof response.error === 'string') {
            fail(check, response.error || '规则检查失败，请重试。')
          } else if (isCheckResult(response.result, check.month)) {
            active = undefined
            cleanup(check)
            options.onChange({ status: 'ready', month: check.month, result: response.result })
          } else {
            fail(check, '规则检查返回了无效结果，请重试。')
          }
        }
        worker.onerror = (event: ErrorEvent) => {
          event.preventDefault?.()
          fail(check, '规则检查运行失败，请重试。')
        }
        worker.onmessageerror = () => fail(check, '无法读取规则检查结果，请重试。')
        const request: ScheduleCheckRequest = { requestId: check.requestId, month: check.month, referenceDate, state: snapshot }
        worker.postMessage(request)
      } catch {
        fail(check, '无法启动规则检查，请重试。')
      }
    })
  }

  return { start, cancel, dispose: () => { disposed = true; cancel() } }
}
