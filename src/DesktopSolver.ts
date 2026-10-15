import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Assignment, Issue, PlannerState } from './domain.ts'
import { validateSchedule } from './scheduler.ts'

export const desktop = isTauri()
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID' | 'ERROR'
export interface SolverRequest {
  protocolVersion: 1
  requestId: string
  state: PlannerState
  options: { timeLimitSeconds: number; allowPartial: boolean; seed: number }
}
export interface SolverResult {
  protocolVersion: 1
  requestId: string
  engine: 'ortools-cp-sat'
  status: SolverStatus
  assignments?: Assignment[]
  issues: Issue[]
  stats: { wallTimeSeconds: number; objectiveValue?: number; bestBound?: number; shortageCount: number; optimal: boolean; solutionCount?: number }
  hostDiagnostics?: { exitTimedOut?: boolean; phase?: string; code?: string }
  message: string
}
export interface SolverInfo { engine: string; protocolVersion: number; version: string }
export type SolverPhase = 'starting' | 'loading' | 'reading' | 'solving' | 'finishing'
export interface SolverProgress { requestId: string; phase: SolverPhase; solutionCount?: number }
export const solverPhaseLabels: Record<SolverPhase, string> = {
  starting: '正在准备排班',
  loading: '正在准备排班',
  reading: '正在检查设置',
  solving: '正在计算方案与轮班公平性',
  finishing: '正在整理结果',
}
export function matchingSolverPhase(progress: unknown, requestId: string | null): SolverPhase | null {
  if (!requestId || !progress || typeof progress !== 'object') return null
  const value = progress as Partial<SolverProgress>
  return value.requestId === requestId && typeof value.phase === 'string' && Object.hasOwn(solverPhaseLabels, value.phase) ? value.phase as SolverPhase : null
}
/** A count belongs to the same validated progress protocol as its phase. */
export function matchingSolverSolutionCount(progress: unknown, requestId: string | null): number | null {
  if (!matchingSolverPhase(progress, requestId)) return null
  const count = (progress as Partial<SolverProgress>).solutionCount
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
}
export const listenSolverProgress = (callback: (progress: SolverProgress) => void) => listen<SolverProgress>('solver-progress', event => callback(event.payload))

function cleanFailureMessage(message: string): string {
  return message.replace(/\bError:\s*/g, '').replace(/(?:原排班|原表)(?:未被替换|未被改变|未改变|未修改|保持不变)[。；;，,.\s]*/g, '').replace(/(?:[。.]\s*){2,}/g, '。').replace(/^[。；;，,.\s]+|[。；;，,.\s]+$/g, '')
}

const retryGuidance = '排班暂时未完成，请重试；若仍失败，可导出本次规则进一步排查'

/** Display copy only: retain the original response for rule exports and debugging. */
export function formatUserMessage(message: string): string {
  // Unexpected runtime output is not a rule diagnosis. Never expose its stack,
  // file paths or protocol lines in an otherwise user-facing message.
  if (/Traceback|\b\w*(?:Error|Exception):|\bat\s+\S+\s*\([^\n]*:\d+|(?:^|\s)(?:\/(?:Users|home|workspace|tmp|opt|usr)\/|[A-Z]:\\)|SHIFTFLOW_STAGE|\b[A-Z][A-Z_]*(?:TIMEOUT|_ERROR|_EXIT|_INVALID)\b|solution_info|\b(?:site-packages|node_modules)\b/i.test(message)) return `${retryGuidance}。`
  return message
    .replace(/；若允许缺员，可启用后重新求解/g, '')
    .replace(/，允许缺员不会放宽此规则/g, '')
    .replace(/允许缺员也不能突破固定人数上限/g, '人数不得超过固定上限')
    .replace(/允许缺员也不会放宽最低工时/g, '最低工时仍须满足')
    .replace(/缩减模型/g, '减少成员或班次数量')
    .replace(/求解器已证明/g, '已确认')
    .replace(/(?:OR-Tools\s*)?CP-SAT(?:\s+\d+(?:\.\d+)+)?|OR-Tools(?:\s+\d+(?:\.\d+)+)?/gi, '自动排班')
    .replace(/(?:本地|原生|内置)?求解器/g, '排班功能')
    .replace(/本地(?:约束)?求解|本地算法/g, '自动排班')
    .replace(/求解(?:时限|时间)/g, '等待时长')
    .replace(/求解结果/g, '排班结果')
    .replace(/求解过程/g, '排班过程')
    .replace(/求解失败/g, '排班未完成')
    .replace(/重新求解/g, '重新排班')
    .replace(/约束模型/g, '排班设置')
    .replace(/用于复现排查|进一步复现/g, '进一步排查')
    .trim()
}

export function formatUserIssue(issue: Issue): Issue {
  if (issue.type === 'model-invalid') return {
    ...issue,
    message: '部分排班设置无法使用，本次未生成排班。',
    suggestion: '请检查成员、班次与排班规则；若设置无误，请导出本次规则进一步排查。',
  }
  if (issue.type === 'solver-error') return {
    ...issue,
    message: '排班过程中出现问题，本次未生成排班。',
    suggestion: '请重试；若仍失败，可导出本次规则进一步排查。',
  }
  return { ...issue, message: formatUserMessage(issue.message), ...(issue.suggestion === undefined ? {} : { suggestion: formatUserMessage(issue.suggestion) }) }
}

/** Explain the next action without displaying internal errors or repeated safety text. */
export function formatSolverError(error: unknown, context: 'solve' | 'startup' | 'cancel' = 'solve'): { message: string; code: string; diagnostic: boolean } {
  const object = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const raw = error instanceof Error ? error.message : typeof object?.message === 'string' ? object.message : String(error ?? '')
  const code = typeof object?.code === 'string' ? object.code : raw.match(/\b(STARTUP_TIMEOUT|SOLVE_TIMEOUT|EXIT_TIMEOUT|TIMEOUT|OUTPUT_INVALID|STAGE_PROTOCOL_ERROR|STARTUP_PROTOCOL_ERROR|STARTUP_ERROR|INPUT_ERROR|PROCESS_EXIT|CANCELLED)\b/)?.[1] || ''
  const descriptions: Record<string, string> = {
    STARTUP_TIMEOUT: '排班准备超时，尚未开始生成排班。请重试；若仍失败，请重启应用',
    SOLVE_TIMEOUT: '排班超过等待时长，任务已停止。这不能证明规则无解，可增加等待时长后重试',
    EXIT_TIMEOUT: '排班结果未能及时完成确认，任务已停止。请重试；若仍失败，请重启应用',
    TIMEOUT: '排班等待超时，无法据此判断规则是否无解。请重试；若仍失败，请重启应用',
    OUTPUT_INVALID: '本次排班结果不完整，无法保存。请重试；若仍失败，请更新应用',
    STAGE_PROTOCOL_ERROR: '排班暂时无法继续。请重启应用；若仍失败，请更新应用',
    STARTUP_PROTOCOL_ERROR: '排班暂时无法开始。请重启应用；若仍失败，请更新应用',
    STARTUP_ERROR: '排班暂时无法开始。请重试；若仍失败，请重启应用',
    INPUT_ERROR: '本次排班设置未能读取。请重试；若仍失败，可导出本次规则进一步排查',
    PROCESS_EXIT: retryGuidance,
    CANCELLED: '已取消本次排班',
  }
  const reason = descriptions[code] || (context === 'startup' ? '排班暂时无法开始。请重试；若仍失败，请重启应用' : context === 'cancel' ? '取消请求尚未完成，请重试' : retryGuidance)
  const suffix = context === 'startup' ? '。' : context === 'cancel' ? '。当前结果不会写入排班表。' : '。原排班未改变。'
  return { message: `${reason}${suffix}`, code, diagnostic: context === 'startup' || ['STARTUP_TIMEOUT', 'EXIT_TIMEOUT', 'TIMEOUT'].includes(code) }
}
export const solveDesktop = (request: SolverRequest) => invoke<SolverResult>('solve_schedule', { request })
export const cancelDesktop = (requestId: string) => invoke<boolean>('cancel_solve', { requestId })
export const desktopSolverInfo = () => invoke<SolverInfo>('solver_info')
export const importDesktopBackup = () => invoke<string | null>('import_backup')
export function exportDesktopFile(data: string | Uint8Array, fileName: string) {
  const contents = Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data)
  return invoke<boolean>('save_export', { fileName, contents })
}

/** Never accept a successful native response without independent rule validation. */
export function checkDesktopResult(request: SolverRequest, result: SolverResult): { assignments?: Assignment[]; issues: Issue[]; message: string; success: boolean } {
  const reject = (message: string, issues: Issue[] = []) => ({ success: false, issues: issues.map(formatUserIssue), message: formatUserMessage(message) })
  if (!result || result.protocolVersion !== 1 || result.requestId !== request.requestId || result.engine !== 'ortools-cp-sat') return reject('无法确认本次排班结果，请重新生成。原排班未改变。')
  const responseIssues = Array.isArray(result.issues) ? result.issues : []
  if (result.status !== 'OPTIMAL' && result.status !== 'FEASIBLE') {
    if (result.status === 'INFEASIBLE') {
      // Old solvers only returned a list of every possible rule. Do not repeat it
      // or present that list as a diagnosis of this particular request.
      const concrete = responseIssues.filter(issue => issue.type !== 'infeasible')
      const localized = concrete.some(issue => !['diagnosis-incomplete', 'diagnosis-background'].includes(issue.type))
      const message = localized
        ? '本次配置无法排班，请按下方冲突逐项调整。原排班未改变。'
        : '已确认本次规则无可行解，但尚未定位具体冲突。请导出本次规则进一步排查；原排班未改变。'
      return reject(message, concrete)
    }
    const messages: Record<string, string> = {
      UNKNOWN: '在限定时间内尚未找到可行方案，这不代表无解。可以增加等待时长或调整规则；原排班未改变。',
      MODEL_INVALID: '部分排班设置无法使用，请检查设置或导出本次规则进一步排查。原排班未改变。',
      CANCELLED: '已取消本次排班。原排班未改变。',
    }
    if (result.status === 'ERROR') return reject(formatSolverError(result.message).message, responseIssues)
    const summary = cleanFailureMessage(messages[result.status] || retryGuidance)
    return reject(`${summary}。原排班未改变。`, responseIssues)
  }
  if (!Array.isArray(result.assignments)) return reject('本次排班结果缺少明细，请重新生成。原排班未改变。')
  if (result.assignments.some(a => !a || typeof a.employeeId !== 'string' || typeof a.date !== 'string' || typeof a.shiftId !== 'string' || typeof a.locked !== 'boolean')) return reject('本次排班明细无法读取，请重新生成。原排班未改变。')
  // Locked entries and other months must survive exactly, including explicit days off.
  const fixed = request.state.assignments.filter(a => a.locked || !a.date.startsWith(`${request.state.month}-`))
  for (const a of fixed) if (!result.assignments.some(b => a.employeeId === b.employeeId && a.date === b.date && a.shiftId === b.shiftId && a.locked === b.locked)) return reject('求解结果改变了锁定安排或其他月份，已拒绝覆盖原表。')
  const sameAssignment = (a: Assignment, b: Assignment) => a.employeeId === b.employeeId && a.date === b.date && a.shiftId === b.shiftId && a.locked === b.locked
  // A solver may preserve locks but cannot create them. In particular, marking
  // a new month-end night as locked would turn its outgoing hours into false
  // "known outside" credit when independently checking weekly minimums.
  if (result.assignments.some(a => a.locked && !fixed.some(b => sameAssignment(a, b)))) return reject('求解结果新增了未经确认的锁定安排，已拒绝覆盖原表。')
  const originalOtherMonths = request.state.assignments.filter(a => !a.date.startsWith(`${request.state.month}-`))
  const resultOtherMonths = result.assignments.filter(a => !a.date.startsWith(`${request.state.month}-`))
  if (originalOtherMonths.length !== resultOtherMonths.length || resultOtherMonths.some(a => !originalOtherMonths.some(b => sameAssignment(a, b)))) return reject('求解结果改变了其他月份，已拒绝覆盖原表。')
  const checked = validateSchedule({ ...request.state, assignments: result.assignments })
  const hard = checked.filter(i => i.severity === 'error')
  if (hard.length) return reject(`求解结果未通过独立规则检查，原排班未改变：${hard[0]!.message}`, checked)
  if (!request.options.allowPartial && checked.some(i => i.type === 'coverage')) return reject('求解结果仍有岗位缺口，不符合本次完整排班要求；原排班未改变。', checked)
  const status = '排班已生成'
  const shortages = checked.filter(i => i.type === 'coverage').length
  return { success: true, assignments: result.assignments, issues: checked.map(formatUserIssue), message: `${status}。${shortages ? `有 ${shortages} 个班次存在缺编，请查看排班提醒。` : '所有岗位已覆盖，规则检查通过。'}` }
}
