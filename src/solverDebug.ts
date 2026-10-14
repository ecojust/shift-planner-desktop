import type { PlannerState } from './domain.ts'
import type { SolverRequest } from './DesktopSolver.ts'
import { resolveHoursState } from './hours.ts'

const MAX_INPUT_BYTES = 8 * 1024 * 1024

export interface SolverDebugMetadata {
  buildVersion?: string
  exportedAt?: string
  source?: 'current' | 'attempt'
  runtime?: 'desktop' | 'browser'
  /** Only the original hour defaults are retained, not a second full roster. */
  originalState?: PlannerState
}

function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('规则中包含无效数字，请先检查工时和人数设置。')
    return item
  }, space)
}

/** Take a detached snapshot before resolving defaults. Vue reactive state is
 * deliberately copied through JSON; structuredClone cannot clone its proxies. */
export function createSolverRequest(state: PlannerState, options: SolverRequest['options'], requestId: string): SolverRequest {
  // Profile images have no scheduling meaning. Keep them out of worker/IPC and
  // debug requests; they remain intact in the live document and full backups.
  const employees = state.employees.map(({ avatar: _avatar, ...employee }) => employee)
  const snapshot = JSON.parse(stringify({ state: { ...state, employees }, options })) as { state: PlannerState; options: SolverRequest['options'] }
  return { protocolVersion: 1, requestId, state: resolveHoursState(snapshot.state), options: snapshot.options }
}

/** The root is the actual solver protocol, so it works with both --input and
 * stdin. Extra metadata is ignored by the solver and never rewrites the request. */
export function solverDebugJSON(request: SolverRequest, metadata: SolverDebugMetadata = {}): string {
  const { originalState, buildVersion, exportedAt, source, runtime } = metadata
  const payload = {
    ...request,
    debug: {
      format: 'shiftflow-solver-debug',
      formatVersion: 1,
      exportedAt: exportedAt ?? new Date().toISOString(),
      ...(buildVersion ? { buildVersion } : {}),
      source: source ?? 'current',
      ...(runtime ? { runtime } : {}),
      ...(originalState ? { originalHourDefaults: originalState.employees.map(employee => ({
        employeeId: employee.id,
        minHoursPerMonth: employee.minHoursPerMonth,
        minHoursPerWeek: employee.minHoursPerWeek,
      })) } : {}),
    },
  }
  let json = stringify(payload, 2) + '\n'
  const size = (text: string) => new TextEncoder().encode(text).length
  // Large histories may fit the protocol without indentation; never truncate
  // previous-month assignments or silently drop a constraint to reduce size.
  if (size(json) > MAX_INPUT_BYTES) json = stringify(payload) + '\n'
  if (size(json) > MAX_INPUT_BYTES) throw new Error('规则文件超过求解器的 8 MiB 上限，无法完整导出。请缩减不再需要的历史数据后重试。')
  return json
}

export function solverDebugFileName(request: SolverRequest, source: 'current' | 'attempt' = 'current'): string {
  const month = request.state.month.replace(/[^0-9-]/g, '') || 'unknown'
  const id = request.requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12)
  return `排班规则-${month}-${source === 'attempt' ? '本次求解' : '当前设置'}${id ? `-${id}` : ''}.json`
}
