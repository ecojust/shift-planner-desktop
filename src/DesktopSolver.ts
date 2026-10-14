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
  stats: { wallTimeSeconds: number; objectiveValue?: number; bestBound?: number; shortageCount: number; optimal: boolean }
  hostDiagnostics?: { exitTimedOut?: boolean; phase?: string; code?: string }
  message: string
}
export interface SolverInfo { engine: string; protocolVersion: number; version: string }
export type SolverPhase = 'starting' | 'loading' | 'reading' | 'solving' | 'finishing'
export interface SolverProgress { requestId: string; phase: SolverPhase }
export const solverPhaseLabels: Record<SolverPhase, string> = {
  starting: '正在启动本地求解器',
  loading: '正在加载算法组件',
  reading: '正在读取排班配置',
  solving: '正在计算方案与轮班公平性',
  finishing: '正在校验并整理结果',
}
export function matchingSolverPhase(progress: unknown, requestId: string | null): SolverPhase | null {
  if (!requestId || !progress || typeof progress !== 'object') return null
  const value = progress as Partial<SolverProgress>
  return value.requestId === requestId && typeof value.phase === 'string' && Object.hasOwn(solverPhaseLabels, value.phase) ? value.phase as SolverPhase : null
}
export const listenSolverProgress = (callback: (progress: SolverProgress) => void) => listen<SolverProgress>('solver-progress', event => callback(event.payload))

function cleanFailureMessage(message: string): string {
  return message.replace(/\bError:\s*/g, '').replace(/(?:原排班|原表)(?:未被替换|未被改变|未改变|未修改|保持不变)[。；;，,.\s]*/g, '').replace(/(?:[。.]\s*){2,}/g, '。').replace(/^[。；;，,.\s]+|[。；;，,.\s]+$/g, '')
}

/** Present one useful failure, not a Rust message wrapped in repeated safety text. */
export function formatSolverError(error: unknown, context: 'solve' | 'startup' | 'cancel' = 'solve'): { message: string; code: string; diagnostic: boolean } {
  const object = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const raw = error instanceof Error ? error.message : typeof object?.message === 'string' ? object.message : String(error ?? '')
  const code = typeof object?.code === 'string' ? object.code : raw.match(/\b(STARTUP_TIMEOUT|SOLVE_TIMEOUT|EXIT_TIMEOUT|TIMEOUT)\b/)?.[1] || ''
  const startupPhase = raw.match(/阶段\s+(starting|loading|reading)\b/)?.[1]
  const startupLocation = startupPhase === 'starting' ? '启动超时，可能停在运行时载入或系统检查' : startupPhase === 'loading' ? '算法依赖加载超时' : startupPhase === 'reading' ? '排班数据读取超时' : '启动或组件加载超时'
  const descriptions: Record<string, string> = {
    STARTUP_TIMEOUT: `本地求解器${startupLocation}，尚未开始排班搜索。请重新检测本地算法`,
    SOLVE_TIMEOUT: '求解过程超过搜索时限及收尾缓冲，任务已停止。这不能证明规则无解，可增加搜索时间后重试',
    EXIT_TIMEOUT: '本地求解器未能及时完成结果返回或退出，任务已停止。请重新检测本地算法后重试',
    TIMEOUT: '本地算法任务超时；旧版组件没有报告具体阶段，无法据此判断规则是否无解。请重新检测并更新桌面版',
  }
  const clean = cleanFailureMessage(raw)
  const reason = descriptions[code] || clean || '本地求解器未返回错误详情'
  const prefix = descriptions[code] ? '' : context === 'startup' ? '本地算法检测失败：' : context === 'cancel' ? '取消请求未完成：' : '本地求解未完成：'
  const suffix = context === 'startup' ? '。' : context === 'cancel' ? '。当前结果不会写入排班表。' : '。原排班未改变。'
  return { message: `${prefix}${reason}${suffix}`, code, diagnostic: context === 'startup' || ['STARTUP_TIMEOUT', 'EXIT_TIMEOUT', 'TIMEOUT'].includes(code) }
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
  const reject = (message: string, issues: Issue[] = []) => ({ success: false, issues, message })
  if (!result || result.protocolVersion !== 1 || result.requestId !== request.requestId || result.engine !== 'ortools-cp-sat') return reject('本地求解器返回的结果协议不匹配，原排班未改变。')
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
      UNKNOWN: '在限定时间内尚未找到可行方案，这不代表无解。可以增加求解时间或调整规则；原排班未改变。',
      MODEL_INVALID: '排班配置或约束模型无效，原排班未改变。',
      ERROR: '本地求解失败，原排班未改变。',
    }
    if (result.status === 'ERROR') return reject(formatSolverError(result.message).message, responseIssues)
    const summary = cleanFailureMessage(messages[result.status] || '本地求解未完成')
    const detail = cleanFailureMessage(result.message || '')
    return reject(`${summary}${detail && !summary.includes(detail) ? `。${detail}` : ''}。原排班未改变。`, responseIssues)
  }
  if (!Array.isArray(result.assignments)) return reject('求解器未返回排班明细，原排班未改变。')
  if (result.assignments.some(a => !a || typeof a.employeeId !== 'string' || typeof a.date !== 'string' || typeof a.shiftId !== 'string' || typeof a.locked !== 'boolean')) return reject('求解器返回的排班明细格式无效，原排班未改变。')
  // Locked entries and other months must survive exactly, including explicit days off.
  const fixed = request.state.assignments.filter(a => a.locked || !a.date.startsWith(`${request.state.month}-`))
  for (const a of fixed) if (!result.assignments.some(b => a.employeeId === b.employeeId && a.date === b.date && a.shiftId === b.shiftId && a.locked === b.locked)) return reject('求解结果改变了锁定安排或其他月份，已拒绝覆盖原表。')
  const sameAssignment = (a: Assignment, b: Assignment) => a.employeeId === b.employeeId && a.date === b.date && a.shiftId === b.shiftId && a.locked === b.locked
  const originalOtherMonths = request.state.assignments.filter(a => !a.date.startsWith(`${request.state.month}-`))
  const resultOtherMonths = result.assignments.filter(a => !a.date.startsWith(`${request.state.month}-`))
  if (originalOtherMonths.length !== resultOtherMonths.length || resultOtherMonths.some(a => !originalOtherMonths.some(b => sameAssignment(a, b)))) return reject('求解结果改变了其他月份，已拒绝覆盖原表。')
  const checked = validateSchedule({ ...request.state, assignments: result.assignments })
  const hard = checked.filter(i => i.severity === 'error')
  if (hard.length) return reject(`求解结果未通过独立规则检查，原排班未改变：${hard[0]!.message}`, checked)
  if (!request.options.allowPartial && checked.some(i => i.type === 'coverage')) return reject('求解结果仍有岗位缺口，不符合本次完整排班要求；原排班未改变。', checked)
  const status = result.status === 'OPTIMAL' ? '已找到最优方案（按当前公平性目标）' : '已找到可行方案，尚未证明最优'
  const shortages = checked.filter(i => i.type === 'coverage').length
  const cleanup = result.hostDiagnostics?.exitTimedOut ? '有效结果已保存；算法进程退出清理超时，已由应用停止。' : ''
  return { success: true, assignments: result.assignments, issues: checked, message: `${status}。${shortages ? `有 ${shortages} 个班次存在缺编，请查看排班提醒。` : '所有岗位已覆盖，规则检查通过。'}${cleanup}` }
}
