<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import InfoTip from './InfoTip.vue'
import SettingsPanel from './SettingsPanel.vue'
import IntegrationSettings from './IntegrationSettings.vue'
import { useIntegrations } from './integrations'
import { IntegrationError, type IntegrationGenerationAdapter, type IntegrationSource } from './integrationData'
import { configurationFields, markSchedulesCurrent, withChangeProvenance, type ChangeStamp } from './dataProvenance'
import { formatChangeTime } from './changeTime'
import { reorderVisibleEmployees } from './employeeOrder'
import { useEmployeeReorder, type EmployeeOrderChange } from './useEmployeeReorder'
import SourceBadge from './SourceBadge.vue'
import EmployeeAvatar from './EmployeeAvatar.vue'
import MonthPicker from './MonthPicker.vue'
import AppSelect from './AppSelect.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { makeDefaultState } from './defaults'
import { datesOfMonth, shiftHours, validateSchedule } from './scheduler'
import { backupJSON, loadSaved, parseBackup, saveLocal, scheduleXLSX, MAX_BACKUP_BYTES } from './storage'
import { calculatePayroll, createPayrollConfig, dayInfo, payrollRows } from './payroll'
import type { DayKind, PayrollConfig, PayrollResult } from './payroll'
import type { Assignment, Employee, Issue, PlannerState, Shift } from './domain'
import { desktop, solveDesktop, cancelDesktop, desktopSolverInfo, importDesktopBackup, exportDesktopFile, checkDesktopResult, listenSolverProgress, matchingSolverPhase, matchingSolverSolutionCount, solverPhaseLabels, formatSolverError, formatUserMessage, formatUserIssue } from './DesktopSolver'
import type { SolverRequest, SolverPhase } from './DesktopSolver'
import { BUILD_VERSION } from './buildInfo'
import { monthlyHoursByEmployee } from './hours.ts'
import { createSolverRequest, solverDebugJSON, solverDebugFileName } from './solverDebug'
import { parseRulesImport } from './rulesImport'
import { withSolverGuidance, diagnosticActionLabel, openingWeekNotice } from './solverGuidance'
import './planner.css'

const brandMarkUrl = `${import.meta.env.BASE_URL}brand-mark.png`
const helpQrCodeUrl = `${import.meta.env.BASE_URL}qrcode_for_gh_a8aeeae2d3cd_258.jpg`

type Document = PlannerState & PayrollConfig
type Section = 'calendar' | 'team' | 'shifts' | 'rules'
const notice = ref('')
const saveError = ref('')
let initial: PlannerState | null = null
try { initial = loadSaved() } catch (e) { saveError.value = `原有数据读取失败，未覆盖原存档。${e instanceof Error ? e.message : ''}` }
const state = ref<Document>({ ...makeInitial(), ...((initial || {}) as Partial<Document>) })
function makeInitial(): Document { return { ...(initial || makeDefaultState()), ...createPayrollConfig() } }
const section = ref<Section>('calendar')
const mobileNav = ref(false)
const sidebarPreferenceKey = 'shift-planner:sidebar-collapsed:v1'
const sidebarCollapsed = ref(false)
try { sidebarCollapsed.value = localStorage.getItem(sidebarPreferenceKey) === 'true' } catch { /* UI preferences are optional when storage is unavailable. */ }
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try { localStorage.setItem(sidebarPreferenceKey, String(sidebarCollapsed.value)) } catch { /* Keep the current view usable without persistence. */ }
}
const view = ref<'week' | 'month'>('week')
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
function weekOf(date: string) { const offset = (new Date(`${date.slice(0, 7)}-01T12:00:00`).getDay() + 6) % 7; return Math.floor((Number(date.slice(8)) - 1 + offset) / 7) }
const weekIndex = ref(today.startsWith(state.value.month) ? weekOf(today) : 0)
const employeeQuery = ref('')
const groupFilter = ref('')
const showIssues = ref(false)
const showBackup = ref(false)
const showGenerate = ref(false)
const showHelp = ref(false)
const showIntegrationSettings = ref(false)
const monthDeletion = ref<{ month: string; count: number; revision: number } | null>(null)
const deleteMonthButton = ref<HTMLButtonElement | null>(null)
const cancelMonthDeletionButton = ref<HTMLButtonElement | null>(null)
const generating = ref(false)
const cancelling = ref(false)
const solveTimeLimit = ref(15)
const elapsedSeconds = ref(0)
const phaseSeconds = ref(0)
const solutionCount = ref(0)
const cancellationError = ref('')
const externalGeneration = ref<{ source: IntegrationSource; month: string; timeLimitSeconds: number } | null>(null)
let phaseStartedAt = 0
let discardActiveResult = false
const engineInfo = ref('正在准备自动排班…')
const engineState = ref<'checking' | 'ready' | 'error'>(desktop ? 'checking' : 'ready')
const engineDiagnostic = ref(false)
const solvePhase = ref<SolverPhase>('starting')
type Attempt = { request: SolverRequest; originalState: PlannerState; revision: number }
let activeAttempt: Attempt | null = null
type ExternalGenerationJob = {
  request: SolverRequest
  source: IntegrationSource
  revision: number
  cancelled: boolean
  userCancelled: boolean
  running: boolean
  abortReason?: unknown
  removeAbort?: () => void
  cancelPromise?: Promise<boolean>
}
let externalGenerationJob: ExternalGenerationJob | null = null
const solverFeedback = ref<{ success: boolean; message: string; details: string[]; issues: Issue[]; diagnostic: boolean; attempt: Attempt | null; stale: boolean } | null>(null)
const expandedFeedback = ref(false)
let engineCheckPending = false
let unlistenProgress: (() => void) | null = null
let progressListenerPending: Promise<void> | null = null
const scheduleSource = ref(initial ? '已恢复保存的排班' : '可编辑示例排班')
const storageLocation = desktop ? '此设备' : '当前浏览器'
let activeRequestId: string | null = null
let generationTimer = 0
let disposed = false
const importer = ref<HTMLInputElement | null>(null)
const settingsPanel = ref<InstanceType<typeof SettingsPanel> | null>(null)
const importCandidate = ref<Document | null>(null)
const rulesImporter = ref<HTMLInputElement | null>(null)
const readingRules = ref(false)
const rulesImportError = ref('')
const rulesImportCandidate = ref<{ parsed: ReturnType<typeof parseRulesImport>; revision: number; name: string } | null>(null)
let rulesImportRequest = 0
let rulesImportRevision = 0
const editing = ref<{ employee: Employee; date: string; shiftId: string; locked: boolean } | null>(null)
const calendarDate = ref('')
const calendarKind = ref<DayKind>('workday')
const calendarReset = ref<{ date: string; revision: number } | null>(null)
const history = ref<{ assignments: Assignment[]; leaves: Record<string, string[]>; source: string; configuration: string; invalidatedSchedules: Record<string, ChangeStamp> }[]>([])
const savedAt = ref('')
let acceptingProvenance = false
function acceptProvenance(update: () => void) {
  acceptingProvenance = true
  try { update() } finally { acceptingProvenance = false }
}
function integrationEditingBusy() {
  return employeeReorder.active.value || !!saveError.value || !!editing.value || !!calendarDate.value || !!importCandidate.value || readingRules.value || !!rulesImportCandidate.value || !!monthDeletion.value || !!calendarReset.value || showBackup.value || section.value !== 'calendar'
}
const integrationGeneration: IntegrationGenerationAdapter = {
  acquire(request, source) {
    if (!desktop || disposed) throw new IntegrationError('桌面排班服务暂不可用', 503)
    if (generating.value || externalGenerationJob || integrationEditingBusy()) throw new IntegrationError('应用正在编辑或生成排班，请完成操作并返回排班日历后重试', 409)
    const originalState = { ...clone(state.value), month: request.state.month }
    const job: ExternalGenerationJob = { request, source, revision, cancelled: false, userCancelled: false, running: false }
    externalGenerationJob = job
    activeAttempt = { request, originalState, revision: job.revision }
    activeRequestId = request.requestId
    externalGeneration.value = { source, month: request.state.month, timeLimitSeconds: request.options.timeLimitSeconds }
    // Settings save immediately, so its focus trap can give way to progress.
    showIntegrationSettings.value = false; showHelp.value = false
    beginGenerationProgress()
    return {
      assertCurrent: () => assertExternalGeneration(job),
      release(outcome, error) {
        job.removeAbort?.()
        if (externalGenerationJob !== job) return
        if (!disposed) {
          const prefix = `${source.toUpperCase()} · ${request.state.month}：`
          if (outcome) {
            // The data handler already checked and persisted this exact result.
            // Its own apply advances revision; do not treat that as stale input.
            if (outcome.success) {
              scheduleSource.value = `${source.toUpperCase()} 已生成 ${request.state.month} 排班`
              if (state.value.month === request.state.month) showIssues.value = outcome.issues.length > 0
            }
            feedback(outcome.success, `${prefix}${outcome.message}`, [], false, outcome.success ? [] : outcome.issues)
          } else if (job.userCancelled) feedback(false, `${prefix}本次排班已取消，原排班未改变。`)
          else {
            const failure = error instanceof IntegrationError ? { message: error.message, diagnostic: false } : formatSolverError(error ?? job.abortReason)
            feedback(false, `${prefix}${failure.message}`, [], failure.diagnostic)
          }
        }
        externalGenerationJob = null
        finishGeneration()
      },
    }
  },
  async solve(request, signal) {
    const job = externalGenerationJob
    if (!job || job.request !== request) throw new IntegrationError('本次排班任务已失效', 409)
    const aborted = () => {
      job.abortReason = signal?.reason
      void cancelExternalGeneration(job)
    }
    if (signal) {
      signal.addEventListener('abort', aborted, { once: true })
      job.removeAbort = () => signal.removeEventListener('abort', aborted)
      if (signal.aborted) aborted()
    }
    await ensureProgressListener()
    assertExternalGeneration(job)
    job.running = true
    try { return await solveDesktop(request) }
    catch (error) {
      // Preserve lifecycle HTTP status (permission/stop/deadline) instead of
      // replacing it with the native process's generic cancellation error.
      if (job.cancelled) throw job.abortReason instanceof Error ? job.abortReason : new IntegrationError('本次排班已取消，原排班未改变', 409)
      throw error
    }
    finally { job.running = false }
  },
}
const integration = useIntegrations(
  () => state.value,
  (document, source) => {
    const next = { ...createPayrollConfig(), ...document } as Document
    saveLocal(next)
    acceptProvenance(() => { state.value = next })
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    saveError.value = ''
    history.value = []
    solverFeedback.value = null
    scheduleSource.value = `已通过 ${source.toUpperCase()} 更新`
    flash(`${source.toUpperCase()} 修改已保存，请核对配置来源和排班检查结果`)
  },
  () => generating.value || integrationEditingBusy(),
  integrationGeneration,
)

const navigation: { key: Section; label: string; icon: string }[] = [
  { key: 'calendar', label: '排班日历', icon: 'calendar' }, { key: 'team', label: '成员管理', icon: 'people' },
  { key: 'shifts', label: '班次设置', icon: 'clock' }, { key: 'rules', label: '排班规则', icon: 'rules' },
]
const sectionLabel = computed(() => navigation.find(n => n.key === section.value)!.label)
const dates = computed(() => datesOfMonth(state.value.month))
const monthOffset = computed(() => (new Date(`${state.value.month}-01T12:00:00`).getDay() + 6) % 7)
const openingWeekInfo = computed(() => openingWeekNotice(state.value))
const weekCount = computed(() => Math.ceil((dates.value.length + monthOffset.value) / 7))
const visibleDates = computed(() => view.value === 'month' ? dates.value : dates.value.slice(Math.max(0, weekIndex.value * 7 - monthOffset.value), Math.min(dates.value.length, weekIndex.value * 7 + 7 - monthOffset.value)))
const groups = computed(() => [...new Set(state.value.employees.map(e => e.group).filter(Boolean))])
const employees = computed(() => state.value.employees.filter(e => (!groupFilter.value || e.group === groupFilter.value) && `${e.name}${e.role}`.includes(employeeQuery.value.trim())))
const employeeTable = ref<HTMLTableElement | null>(null)
const canReorderEmployees = computed(() => !generating.value && !saveError.value && section.value === 'calendar'
  && !editing.value && !calendarDate.value && !importCandidate.value && !readingRules.value && !rulesImportCandidate.value
  && !monthDeletion.value && !calendarReset.value && !showBackup.value && !showGenerate.value && !showHelp.value
  && !showIntegrationSettings.value && !mobileNav.value)
let applyingSavedEmployeeOrder = false
const employeeReorder = useEmployeeReorder({
  table: () => employeeTable.value,
  canStart: () => canReorderEmployees.value,
  visibleIds: () => employees.value.map(employee => employee.id),
  revision: () => revision,
  commit: saveEmployeeOrder,
})
function saveEmployeeOrder(change: EmployeeOrderChange) {
  if (!canReorderEmployees.value || change.revision !== revision
    || change.visibleIds.join('\0') !== employees.value.map(employee => employee.id).join('\0')) return false
  const reordered = reorderVisibleEmployees(state.value.employees, change.visibleIds, change.sourceId, change.targetId, change.position)
  if (reordered === state.value.employees) return false
  const next = { ...state.value, employees: reordered }
  try { saveLocal(next) }
  catch { flash('人员顺序保存失败，已保留原顺序。请检查设备存储空间后重试。'); return false }
  const previousFeedback = solverFeedback.value, wasStale = previousFeedback?.stale
  applyingSavedEmployeeOrder = true
  try { acceptProvenance(() => { state.value = next }) }
  finally { applyingSavedEmployeeOrder = false }
  // Order is presentation only, including for a previous infeasible result.
  if (previousFeedback && solverFeedback.value === previousFeedback) previousFeedback.stale = wasStale!
  savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  flash('人员顺序已保存，成员管理已同步')
  return true
}
watch([employeeQuery, groupFilter, section, view, weekIndex, generating, editing, calendarDate, importCandidate,
  readingRules, rulesImportCandidate, monthDeletion, calendarReset, showBackup, showGenerate, showHelp,
  showIntegrationSettings, mobileNav, saveError], () => employeeReorder.cancel(), { flush: 'sync' })
const assignments = computed(() => new Map(state.value.assignments.map(a => [`${a.employeeId}:${a.date}`, a])))
const monthAssignments = computed(() => state.value.assignments.filter(a => a.date.startsWith(state.value.month) && a.shiftId !== 'off'))
const monthEntryCount = computed(() => state.value.assignments.filter(a => a.date.startsWith(`${state.value.month}-`)).length)
const monthScheduleStatuses = computed(() => {
  const statuses: Record<string, { status: 'scheduled' | 'invalid'; description?: string }> = Object.create(null)
  for (const assignment of state.value.assignments) {
    const month = assignment.date.slice(0, 7)
    if (Object.hasOwn(statuses, month)) continue
    const invalidation = state.value.provenance?.invalidatedSchedules?.[month]
    statuses[month] = invalidation ? {
      status: 'invalid',
      description: `成员、班次或规则已于 ${formatChangeTime(invalidation.at)} 修改。已有排班记录仍保留，请按当前配置重新生成。`,
    } : { status: 'scheduled' }
  }
  return statuses
})
const issues = computed(() => validateSchedule(state.value).map(formatUserIssue))
const externalChange = computed(() => state.value.provenance?.pendingExternalChange)
const scheduleUpdate = computed(() => state.value.provenance?.scheduleUpdates?.[state.value.month])
async function reviewExternalChanges() {
  chooseSection('calendar')
  showIssues.value = true
  await nextTick()
  document.querySelector('.sp-issues')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
function acknowledgeExternalChanges() {
  acceptProvenance(() => { if (state.value.provenance) delete state.value.provenance.pendingExternalChange })
}
const payrollCalculation = computed<{ result: PayrollResult; error: string }>(() => {
  try { return { result: calculatePayroll(state.value, { payroll: state.value.payroll, calendar: state.value.calendar }), error: '' } }
  catch (error) {
    return { result: { rows: [], dailyRows: [], totalAllowance: 0, statutoryHours: 0, restdayHours: 0, ordinaryOvertimeHours: 0, warnings: [] }, error: error instanceof Error ? error.message : '津贴暂时无法计算，请检查班次固定金额。' }
  }
})
const payroll = computed(() => payrollCalculation.value.result)
const payrollError = computed(() => payrollCalculation.value.error)
const actualMonthHours = computed(() => monthlyHoursByEmployee(state.value))
const totalHours = computed(() => Number(state.value.employees.reduce((sum, employee) => sum + (actualMonthHours.value.get(employee.id) ?? 0), 0).toFixed(2)))
const requiredPerDay = computed(() => state.value.shifts.reduce((sum, s) => sum + s.required, 0))
const coverage = computed(() => {
  const total = dates.value.length * requiredPerDay.value
  const filled = dates.value.reduce((sum, date) => sum + state.value.shifts.reduce((n, s) => n + Math.min(s.required, monthAssignments.value.filter(a => a.date === date && a.shiftId === s.id).length), 0), 0)
  const excess = dates.value.reduce((sum, date) => sum + state.value.shifts.reduce((n, s) => n + (s.staffingMode === 'fixed' ? Math.max(0, monthAssignments.value.filter(a => a.date === date && a.shiftId === s.id).length - s.required) : 0), 0), 0)
  return { total, filled, excess, percentage: total ? Math.round(filled / total * 100) : 100 }
})
const lockedCount = computed(() => state.value.assignments.filter(a => a.date.startsWith(state.value.month) && a.locked).length)
const dayAllowances = computed(() => new Map(payroll.value.dailyRows.map(row => [`${row.employeeId}:${row.date}`, row])))
const employeeAllowances = computed(() => new Map(payroll.value.rows.map(row => [row.employeeId, row])))
const filteredAllowanceTotal = computed(() => employees.value.reduce((sum, employee) => sum + Math.round((employeeAllowances.value.get(employee.id)?.totalAllowance ?? 0) * 100), 0) / 100)
const monthTitle = computed(() => `${state.value.month.slice(0, 4)} 年 ${Number(state.value.month.slice(5))} 月`)
const generationMonthTitle = computed(() => externalGeneration.value ? `${externalGeneration.value.month.slice(0, 4)} 年 ${Number(externalGeneration.value.month.slice(5))} 月` : monthTitle.value)
const deletionMonthTitle = computed(() => monthDeletion.value ? `${monthDeletion.value.month.slice(0, 4)} 年 ${Number(monthDeletion.value.month.slice(5))} 月` : '')
const period = computed(() => view.value === 'month' ? '整月总览' : `${Number(visibleDates.value[0]?.slice(8))} 日 — ${Number(visibleDates.value.at(-1)?.slice(8))} 日`)

function info(date: string) { return dayInfo(date, state.value.calendar) }
function weekday(date: string) { return ['日', '一', '二', '三', '四', '五', '六'][new Date(`${date}T12:00:00`).getDay()] }
function findShift(id: string): Shift | undefined { return state.value.shifts.find(s => s.id === id) }
function entry(employeeId: string, date: string) { return assignments.value.get(`${employeeId}:${date}`) }
function leave(employee: Employee, date: string) { return employee.unavailableDates.includes(date) }
function employeeHours(id: string) { return Number((actualMonthHours.value.get(id) ?? 0).toFixed(2)) }
function employeeDays(id: string) { return monthAssignments.value.filter(a => a.employeeId === id).length }
function dailyFilled(date: string) { return monthAssignments.value.filter(a => a.date === date).length }
function dailyCovered(date: string) {
  return state.value.shifts.every(shift => {
    const count = monthAssignments.value.filter(a => a.date === date && a.shiftId === shift.id).length
    return shift.staffingMode === 'fixed' ? count === shift.required : count >= shift.required
  })
}
function dayAllowance(employeeId: string, date: string) { return dayAllowances.value.get(`${employeeId}:${date}`) }
function dailyAllowanceTotal(date: string) { return employees.value.reduce((sum, employee) => sum + Math.round((dayAllowance(employee.id, date)?.totalAllowance ?? 0) * 100), 0) / 100 }
function allowanceDescription(employeeId: string, date: string) {
  if (payrollError.value) return payrollError.value
  const row = dayAllowance(employeeId, date)
  if (!row) return '当日额外津贴 ¥0.00'
  return `当日额外津贴 ¥${money(row.totalAllowance)}；每人每班固定金额${row.carriedShiftIds.length ? '；跨夜工时已计入，津贴在开班日领取' : ''}`
}
function money(amount: number) { return amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
// Request correlation does not require a secure-context-only randomUUID API.
function solverRequestId() { return `${Array.from(crypto.getRandomValues(new Uint8Array(12)), value => value.toString(16).padStart(2, '0')).join('')}-${Date.now()}` }
function flash(message: string) { notice.value = formatUserMessage(message); window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => notice.value = '', 5500) }
function scheduleConfigurationKey(document: Document) {
  return JSON.stringify(Object.entries(configurationFields(document))
    .filter(([path]) => /^(employees|shifts|rules)(\.|$)/.test(path))
    .sort(([a], [b]) => a.localeCompare(b)))
}
function remember() {
  history.value.push({ assignments: clone(state.value.assignments), leaves: Object.fromEntries(state.value.employees.map(e => [e.id, [...e.unavailableDates]])), source: scheduleSource.value, configuration: scheduleConfigurationKey(state.value), invalidatedSchedules: clone(state.value.provenance?.invalidatedSchedules ?? {}) })
  if (history.value.length > 10) history.value.shift()
}
function undo() {
  const previous = history.value.pop()
  if (!previous) return
  const at = new Date().toISOString()
  const next = withChangeProvenance(state.value, {
    ...state.value,
    assignments: previous.assignments,
    employees: state.value.employees.map(employee => previous.leaves[employee.id] ? { ...employee, unavailableDates: previous.leaves[employee.id]! } : employee),
  }, 'manual', at) as Document
  // Restoring an older roster must not erase either its old invalidation or a
  // later configuration edit. A deleted month's marker may already be pruned.
  const invalidated = { ...previous.invalidatedSchedules, ...next.provenance?.invalidatedSchedules }
  const months = new Set(next.assignments.map(assignment => assignment.date.slice(0, 7)))
  for (const month of Object.keys(invalidated)) if (!months.has(month)) delete invalidated[month]
  if (scheduleConfigurationKey(next) !== previous.configuration) {
    for (const month of months) invalidated[month] = { source: 'manual', at }
  }
  if (Object.keys(invalidated).length) next.provenance = { ...next.provenance, fields: next.provenance?.fields ?? {}, invalidatedSchedules: invalidated }
  acceptProvenance(() => { state.value = next })
  scheduleSource.value = previous.source; solverFeedback.value = null; expandedFeedback.value = false
  flash('已撤销上一次排班调整')
}
function commitGeneratedAssignments(assignments: Assignment[], month: string) {
  remember()
  const next = markSchedulesCurrent(withChangeProvenance(state.value, { ...state.value, assignments }, 'manual') as Document, [month])
  acceptProvenance(() => { state.value = next })
}
function requestMonthDeletion() {
  if (generating.value || !monthEntryCount.value) return
  monthDeletion.value = { month: state.value.month, count: monthEntryCount.value, revision }
}
function closeMonthDeletion(restoreFocus = true) {
  monthDeletion.value = null
  if (!restoreFocus) return
  void nextTick(() => {
    if (disposed || generating.value || monthDeletion.value) return
    const target = deleteMonthButton.value && !deleteMonthButton.value.disabled ? deleteMonthButton.value : document.querySelector<HTMLElement>('.sp-calendar-card')
    target?.focus({ preventScroll: true })
  })
}
function confirmMonthDeletion() {
  const target = monthDeletion.value
  if (!target) return
  if (generating.value || target.month !== state.value.month || target.revision !== revision) { closeMonthDeletion(false); return }
  const remaining = state.value.assignments.filter(assignment => !assignment.date.startsWith(`${target.month}-`))
  if (remaining.length === state.value.assignments.length) { closeMonthDeletion(); return }
  const title = deletionMonthTitle.value
  remember()
  closeMonthDeletion()
  state.value.assignments = remaining
  solverFeedback.value = null; expandedFeedback.value = false; activeAttempt = null
  showIssues.value = false; editing.value = null; calendarDate.value = ''
  scheduleSource.value = `${title}排班已删除`
  flash(`已删除 ${title}的 ${target.count} 条排班记录，可撤销上次调整恢复。`)
}
function chooseSection(value: Section) { section.value = value; mobileNav.value = false }
function changeMonth(value: string) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1) return; state.value.month = value; weekIndex.value = 0; history.value = [] }
function navigateMonth(direction: number) {
  const index = Number(state.value.month.slice(0, 4)) * 12 + Number(state.value.month.slice(5)) - 1 + direction
  if (index < 12 || index >= 120000) return
  changeMonth(`${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`)
}
function navigatePeriod(direction: number) {
  if (view.value === 'week' && weekIndex.value + direction >= 0 && weekIndex.value + direction < weekCount.value) weekIndex.value += direction
}
function goToday() { changeMonth(today.slice(0, 7)); weekIndex.value = weekOf(today) }
function openCell(employee: Employee, date: string) { const a = entry(employee.id, date); editing.value = { employee, date, shiftId: leave(employee, date) ? 'leave' : a?.shiftId || 'off', locked: a?.locked ?? true } }
function saveCell() {
  const edit = editing.value; if (!edit) return
  remember()
  const assignments = state.value.assignments.filter(a => !(a.employeeId === edit.employee.id && a.date === edit.date))
  const unavailableDates = edit.employee.unavailableDates.filter(d => d !== edit.date)
  if (edit.shiftId === 'leave') unavailableDates.push(edit.date)
  else assignments.push({ employeeId: edit.employee.id, date: edit.date, shiftId: edit.shiftId, locked: edit.locked })
  // Commit the cell and leave configuration together: a temporary empty month
  // must not clear its invalidation while replacing its only assignment.
  state.value = { ...state.value, assignments, employees: state.value.employees.map(employee => employee.id === edit.employee.id ? { ...employee, unavailableDates } : employee) }
  editing.value = null
  const conflict = issues.value.find(i => i.employeeId === edit.employee.id && (!i.date || i.date === edit.date))
  flash(conflict ? `已保存，请处理冲突：${conflict.message}` : '班次已更新，锁定班次会在重新生成时保留')
}
function openDate(date: string) { calendarDate.value = date; calendarKind.value = info(date).kind }
function saveCalendar() { state.value.calendar[calendarDate.value] = calendarKind.value; calendarDate.value = ''; flash('日期类型已更新；津贴按排班领取固定金额') }
function requestCalendarReset() {
  if (generating.value || !Object.hasOwn(state.value.calendar, calendarDate.value)) return
  calendarReset.value = { date: calendarDate.value, revision }
}
function confirmCalendarReset() {
  const target = calendarReset.value
  calendarReset.value = null
  if (!target || generating.value || target.revision !== revision || target.date !== calendarDate.value) return
  delete state.value.calendar[target.date]
  calendarDate.value = ''
  flash(`${target.date} 已恢复默认日期类型。`)
}
let worker: Worker | null = null
let workerTimer = 0
let revision = 0
function beginGenerationProgress() {
  showGenerate.value = true; generating.value = true; cancelling.value = false
  cancellationError.value = ''; discardActiveResult = false
  solverFeedback.value = null; elapsedSeconds.value = 0; phaseSeconds.value = 0; solutionCount.value = 0; solvePhase.value = desktop ? 'starting' : 'solving'
  const started = performance.now(); phaseStartedAt = started
  window.clearInterval(generationTimer)
  generationTimer = window.setInterval(() => {
    const now = performance.now()
    elapsedSeconds.value = Math.max(0, Math.floor((now - started) / 1000))
    phaseSeconds.value = Math.max(0, Math.floor((now - phaseStartedAt) / 1000))
  }, 250)
}
function assertExternalGeneration(job: ExternalGenerationJob) {
  if (disposed) throw new IntegrationError('应用已关闭，本次排班已停止', 503)
  if (externalGenerationJob !== job || activeRequestId !== job.request.requestId || !generating.value) throw new IntegrationError('本次排班任务已失效', 409)
  if (job.cancelled || discardActiveResult) throw job.abortReason instanceof Error ? job.abortReason : new IntegrationError('本次排班已取消，原排班未改变', 409)
  if (job.revision !== revision) throw new IntegrationError('排班期间设置或排班发生变化，已保留你的修改。请读取最新 revision 后重试', 409)
  if (integrationEditingBusy()) throw new IntegrationError('应用正在编辑或导入数据，已保留原排班，请完成操作后重试', 409)
}
async function cancelExternalGeneration(job: ExternalGenerationJob) {
  job.cancelled = true
  if (externalGenerationJob !== job) return
  discardActiveResult = true; cancelling.value = true; cancellationError.value = ''
  if (!job.running) return
  try {
    if (!job.cancelPromise) job.cancelPromise = cancelDesktop(job.request.requestId).finally(() => { job.cancelPromise = undefined })
    const stopped = await job.cancelPromise
    if (!disposed && externalGenerationJob === job && !stopped) {
      cancelling.value = false
      cancellationError.value = '取消尚未确认，可以重试取消；本次结果不会写入排班表。'
    }
  } catch (error) {
    if (!disposed && externalGenerationJob === job) {
      cancelling.value = false
      cancellationError.value = formatSolverError(error, 'cancel').message
    }
  }
  // The lease remains locked until the handler has discarded the candidate.
}
function finishGeneration() {
  worker?.terminate(); worker = null
  window.clearTimeout(workerTimer); window.clearInterval(generationTimer)
  generating.value = false; cancelling.value = false; activeRequestId = null
  externalGeneration.value = null
  showGenerate.value = false
  void nextTick(() => {
    if (!disposed && !showGenerate.value && !generating.value) document.querySelector<HTMLButtonElement>('.sp-heading-actions .sp-primary')?.focus({ preventScroll: true })
  })
}
function feedback(success: boolean, message: string, details: string[] = [], diagnostic = false, issues: Issue[] = []) {
  const visibleMessage = formatUserMessage(message)
  // Both success paths check the input revision before committing assignments.
  // That commit advances revision itself; it does not make its own result stale.
  solverFeedback.value = { success, message: visibleMessage, details: [...new Set(details.map(formatUserMessage))].filter(detail => !visibleMessage.includes(detail)), diagnostic, issues: withSolverGuidance(issues).map(formatUserIssue), attempt: activeAttempt, stale: !success && !!activeAttempt && activeAttempt.revision !== revision }
  expandedFeedback.value = false
  // The persistent result card is the sole announcement of solver outcomes.
  notice.value = ''; window.clearTimeout(noticeTimer)
}
function receiveSolverProgress(progress: unknown) {
  if (disposed || !generating.value) return
  const phase = matchingSolverPhase(progress, activeRequestId)
  if (phase && phase !== solvePhase.value) {
    solvePhase.value = phase; phaseStartedAt = performance.now(); phaseSeconds.value = 0
  }
  const count = matchingSolverSolutionCount(progress, activeRequestId)
  if (count !== null) solutionCount.value = Math.max(solutionCount.value, count)
}
async function ensureProgressListener() {
  if (unlistenProgress) return
  if (!progressListenerPending) progressListenerPending = listenSolverProgress(receiveSolverProgress)
    .then(unlisten => { if (disposed) unlisten(); else unlistenProgress = unlisten }).finally(() => { progressListenerPending = null })
  await progressListenerPending
}
async function checkEngine() {
  if (!desktop || disposed || engineCheckPending || generating.value) return
  engineCheckPending = true; engineState.value = 'checking'; engineDiagnostic.value = false
  engineInfo.value = '正在准备自动排班，首次使用请稍候…'
  try {
    await ensureProgressListener()
    if (disposed) return
    const info = await desktopSolverInfo()
    if (disposed) return
    if (info.engine !== 'ortools-cp-sat' || info.protocolVersion !== 1 || !info.version) throw new Error('自动排班暂不可用，请更新应用后重试')
    engineInfo.value = '可以开始生成排班'
    engineState.value = 'ready'
  } catch (error) {
    if (!disposed) { const failure = formatSolverError(error, 'startup'); engineInfo.value = failure.message; engineState.value = 'error'; engineDiagnostic.value = failure.diagnostic }
  } finally { engineCheckPending = false }
}
async function generate() {
  if (generating.value || (desktop && engineState.value !== 'ready')) return
  externalGeneration.value = null; activeAttempt = null
  beginGenerationProgress()
  let request: SolverRequest
  const inputRevision = revision
  try {
    const originalState = clone(state.value)
    request = createSolverRequest(originalState, { timeLimitSeconds: solveTimeLimit.value, allowPartial: false, seed: Math.floor(Math.random() * 2147483647) }, solverRequestId())
    activeAttempt = { request, originalState, revision: inputRevision }
    activeRequestId = request.requestId
  } catch {
    feedback(false, '排班设置未能读取，请检查成员、班次和规则后重试。原排班未改变。')
    finishGeneration()
    return
  }
  const isCurrent = () => !disposed && activeRequestId === request.requestId
  if (desktop) {
    try {
      const result = await solveDesktop(request)
      if (!isCurrent()) return
      if (discardActiveResult) feedback(false, '本次排班已取消，原排班未改变。')
      else if (inputRevision !== revision) feedback(false, '排班期间设置或排班发生变化，已保留你的修改。请按最新设置重新生成。')
      else {
        const checked = checkDesktopResult(request, result)
        if (checked.success && checked.assignments) {
          commitGeneratedAssignments(checked.assignments, request.state.month); showIssues.value = checked.issues.length > 0
          scheduleSource.value = '已自动生成排班'
        }
        feedback(checked.success, checked.message, [], false, checked.success ? [] : checked.issues)
      }
    } catch (error) {
      if (isCurrent()) {
        if (discardActiveResult) feedback(false, '本次排班已取消，原排班未改变。')
        else {
          const failure = formatSolverError(error)
          feedback(false, failure.message, [], failure.diagnostic)
          if (failure.diagnostic) { engineState.value = 'error'; engineInfo.value = '自动排班暂不可用，请重试。'; engineDiagnostic.value = true }
        }
      }
    } finally { if (isCurrent()) finishGeneration() }
    return
  }
  try {
    worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (!isCurrent()) return
      if (event.data && typeof event.data === 'object' && Object.hasOwn(event.data, 'progress')) {
        receiveSolverProgress(event.data.progress)
        return
      }
      try {
        const { result, error } = event.data
        if (inputRevision !== revision) feedback(false, '排班期间设置发生变化，已保留你的修改。请按最新设置重新生成。')
        else if (error || !Array.isArray(result?.issues) || !Array.isArray(result?.assignments)) feedback(false, '排班暂时未完成，请重试；原排班未改变。')
        else {
          const blockingIssues = result.issues.filter((issue: Issue) => issue.severity === 'error' || issue.type === 'coverage')
          if (result.success === false || blockingIssues.length) feedback(false, '暂未找到符合规则的排班方案，这不代表无解。原排班未改变。', ['下方是此次尝试中发现的问题，可参考调整后重试。'], false, blockingIssues)
          else { commitGeneratedAssignments(result.assignments, request.state.month); showIssues.value = result.issues.length > 0; scheduleSource.value = '已自动生成排班'; feedback(true, result.issues.length ? `排班已生成，有 ${result.issues.length} 项需要检查` : '排班已生成，所有岗位已覆盖，规则检查通过') }
        }
      } catch { feedback(false, '排班结果未能读取，请重试；原排班未改变。') }
      finally { if (isCurrent()) finishGeneration() }
    }
    worker.onerror = () => {
      if (!isCurrent()) return
      feedback(false, '排班未完成，请重试；原排班未改变。'); finishGeneration()
    }
    workerTimer = window.setTimeout(() => {
      if (!isCurrent()) return
      feedback(false, '排班等待超时，尚未找到方案，已保留原表。'); finishGeneration()
    }, 30000)
    worker.postMessage({ state: request.state, seed: request.options.seed, requestId: request.requestId })
  } catch {
    if (isCurrent()) { feedback(false, '排班暂时无法开始，请重试；原排班未改变。'); finishGeneration() }
  }
}
async function cancelGeneration() {
  if (!generating.value || cancelling.value) return
  if (externalGenerationJob) {
    externalGenerationJob.userCancelled = true
    await cancelExternalGeneration(externalGenerationJob)
    return
  }
  discardActiveResult = true; cancelling.value = true; cancellationError.value = ''
  if (!desktop) { feedback(false, '本次排班已取消，原排班未改变。'); finishGeneration(); return }
  const requestId = activeRequestId
  if (requestId) {
    try {
      const stopped = await cancelDesktop(requestId)
      if (!disposed && generating.value && activeRequestId === requestId) {
        if (stopped) { feedback(false, '本次排班已取消，原排班未改变。'); finishGeneration() }
        else { cancelling.value = false; cancellationError.value = '取消尚未确认，可以重试取消；本次结果不会写入排班表。' }
      }
    } catch (error) {
      if (!disposed && generating.value && activeRequestId === requestId) {
        cancelling.value = false; cancellationError.value = formatSolverError(error, 'cancel').message
      }
    }
  }
}
async function download(data: string | Uint8Array, name: string, type: string): Promise<boolean> {
  if (desktop) {
    try { return await exportDesktopFile(data, name) }
    catch { throw new Error('文件保存失败，请确认保存位置可以写入，或更换位置后重试。') }
  }
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data).buffer], { type })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
async function exportExcel() {
  if (payrollError.value) { flash(payrollError.value); return }
  const rows = payrollRows(payroll.value)
  try { if (await download(scheduleXLSX(state.value, { payrollRows: rows }), `${state.value.teamName}-${state.value.month}-排班与津贴.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) flash('Excel 已导出，包含排班、班次和津贴明细') } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function exportRules(attempt: Attempt | null = null) {
  try {
    const source = attempt ? 'attempt' : 'current'
    const originalState = attempt?.originalState ?? clone(state.value)
    const request = attempt?.request ?? createSolverRequest(originalState, { timeLimitSeconds: solveTimeLimit.value, allowPartial: false, seed: Math.floor(Math.random() * 2147483647) }, solverRequestId())
    const data = solverDebugJSON(request, { buildVersion: BUILD_VERSION, source, runtime: desktop ? 'desktop' : 'browser', originalState })
    if (await download(data, solverDebugFileName(request, source), 'application/json')) flash(attempt ? '已导出失败当次的排班设置，可用于排查问题' : '已导出当前成员、班次、规则和相关排班记录')
  } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
function cancelRulesImport() {
  rulesImportRequest++
  readingRules.value = false
  rulesImportCandidate.value = null
  rulesImportError.value = ''
  if (rulesImporter.value) rulesImporter.value.value = ''
}
function previewRulesImport(contents: string, name: string, request: number) {
  if (request !== rulesImportRequest || disposed) return
  if (revision !== rulesImportRevision || generating.value || section.value !== 'calendar') {
    throw new Error('选择文件期间排班数据已变化，请重新导入并核对。')
  }
  rulesImportCandidate.value = { parsed: parseRulesImport(contents), revision, name }
}
async function openRulesImport() {
  if (generating.value || readingRules.value || rulesImportCandidate.value) return
  rulesImportError.value = ''
  rulesImportRevision = revision
  const request = ++rulesImportRequest
  readingRules.value = true
  if (!desktop) { rulesImporter.value?.click(); return }
  try {
    const contents = await importDesktopBackup().catch(() => { throw new Error('规则文件读取失败，请选择可以访问的 JSON 文件，大小不超过 8 MB。') })
    if (contents !== null) previewRulesImport(contents, '已选择的规则文件', request)
  } catch (error) {
    if (request === rulesImportRequest) rulesImportError.value = error instanceof Error ? error.message : '规则文件读取失败，请重新选择。'
  } finally { if (request === rulesImportRequest) readingRules.value = false }
}
async function selectRulesImport(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const request = rulesImportRequest
  try {
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) throw new Error('规则文件不能超过 8 MB。')
    previewRulesImport(await file.text(), file.name, request)
  } catch (error) {
    if (request === rulesImportRequest) rulesImportError.value = error instanceof Error ? error.message : '规则文件读取失败，请重新选择。'
  } finally {
    input.value = ''
    if (request === rulesImportRequest) readingRules.value = false
  }
}
function confirmRulesImport() {
  const candidate = rulesImportCandidate.value
  if (!candidate) return
  if (candidate.revision !== revision || generating.value || section.value !== 'calendar') {
    cancelRulesImport()
    rulesImportError.value = '排班数据已变化，请重新导入并核对。'
    return
  }
  try {
    const document = clone(candidate.parsed.document)
    // Rule exports deliberately omit photos. Keep local photos only for the
    // same identified member, without copying any submitted source history.
    for (const employee of document.employees) {
      const current = state.value.employees.find(item => item.id === employee.id && item.name === employee.name)
      if (employee.avatar === undefined && current?.avatar !== undefined) employee.avatar = current.avatar
    }
    const next = withChangeProvenance(state.value, { ...createPayrollConfig(), ...document }, 'manual') as Document
    // Validate and persist the complete replacement before changing the UI.
    try { saveLocal(next) } catch { throw new Error('导入未保存，当前数据未替换。请检查存储空间，或先导出完整备份后重试。') }
    acceptProvenance(() => { state.value = next })
    window.clearTimeout(saveTimer)
    if (candidate.parsed.timeLimitSeconds !== undefined) solveTimeLimit.value = candidate.parsed.timeLimitSeconds
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    saveError.value = ''
    history.value = []; weekIndex.value = 0; employeeQuery.value = ''; groupFilter.value = ''
    solverFeedback.value = null; expandedFeedback.value = false
    scheduleSource.value = '已导入规则文件中的排班'
    cancelRulesImport()
    flash('规则文件已导入，修改来源已记录为手动修改，请核对排班检查结果')
  } catch (error) { rulesImportError.value = error instanceof Error ? error.message : '导入失败，请重新选择规则文件。' }
}
async function openDiagnostic(issue: Issue) {
  if (!issue.target) return
  chooseSection(issue.target)
  if (issue.target === 'calendar') {
    if (issue.date) jumpToIssue(issue.date)
    if (issue.employeeId) { groupFilter.value = ''; employeeQuery.value = state.value.employees.find(e => e.id === issue.employeeId)?.name ?? '' }
  }
  await nextTick()
  if (issue.target !== 'calendar') { await settingsPanel.value?.focusDiagnostic(issue.employeeId, issue.shiftId, issue.type); return }
  const element = document.querySelector<HTMLElement>('.sp-calendar-card')
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element?.focus({ preventScroll: true })
}
async function exportBackup() {
  try { if (await download(backupJSON(state.value), `Shift Schedule Expert-${state.value.month}.json`, 'application/json')) { showBackup.value = false; flash('完整备份已导出') } }
  catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function openImport() {
  if (!desktop) { importer.value?.click(); return }
  try {
    const contents = await importDesktopBackup().catch(() => { throw new Error('备份文件读取失败，请确认文件可以访问且不超过 8 MB，或重新选择文件。') })
    if (contents !== null) { importCandidate.value = { ...createPayrollConfig(), ...parseBackup(contents) } as Document; showBackup.value = false }
  } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function selectImport(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return
  try { if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 8 MB'); importCandidate.value = { ...createPayrollConfig(), ...parseBackup(await file.text()) } as Document }
  catch (e) { flash(e instanceof Error ? e.message : '文件读取失败') }
  input.value = ''; showBackup.value = false
}
function confirmImport() { if (!importCandidate.value) return; const imported = importCandidate.value; acceptProvenance(() => { state.value = imported }); importCandidate.value = null; history.value = []; weekIndex.value = 0; saveError.value = ''; scheduleSource.value = '已导入备份排班'; solverFeedback.value = null; flash('备份已导入') }
function jumpToIssue(date?: string) { if (!date) return; if (!date.startsWith(state.value.month)) changeMonth(date.slice(0, 7)); weekIndex.value = weekOf(date); view.value = 'week' }
let noticeTimer = 0
let saveTimer = 0
let recordingProvenance = false
let provenanceSnapshot = clone({ ...state.value, assignments: [] })
watch(state, () => {
  if (recordingProvenance) return
  employeeReorder.cancel()
  const configurationChanged = scheduleConfigurationKey(provenanceSnapshot) !== scheduleConfigurationKey(state.value)
  recordingProvenance = true
  try {
    if (!acceptingProvenance) {
      const provenance = withChangeProvenance(provenanceSnapshot, state.value, 'manual').provenance
      if (JSON.stringify(provenance) !== JSON.stringify(state.value.provenance)) state.value.provenance = provenance
    }
    provenanceSnapshot = clone({ ...state.value, assignments: [] })
  } finally { recordingProvenance = false }
  revision++
  if (monthDeletion.value) closeMonthDeletion(false)
  calendarReset.value = null
  if (solverFeedback.value && (configurationChanged || !solverFeedback.value.success)) solverFeedback.value.stale = true
  window.clearTimeout(saveTimer)
  if (applyingSavedEmployeeOrder) return
  saveTimer = window.setTimeout(() => {
  if (saveError.value.startsWith('原有数据读取失败')) return
  try { saveLocal(state.value); savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); saveError.value = '' }
  catch { saveError.value = '自动保存失败，请导出 JSON 备份，避免刷新丢失。' }
}, 350) }, { deep: true, flush: 'sync' })
function settingsChanged(options?: { silent?: boolean }) { history.value = []; if (!options?.silent) flash('设置已保存，重新生成可按新规则安排班次') }
watch(() => state.value.month, () => { weekIndex.value = 0; history.value = [] }, { flush: 'sync' })
function flushSave() {
  // Flush valid card edits before persisting, independent of pagehide listener order.
  settingsPanel.value?.flushAutosave()
  if (!saveError.value.startsWith('原有数据读取失败')) { try { saveLocal(state.value) } catch { /* The visible save warning covers storage errors. */ } }
}
function escapeKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && monthDeletion.value) { event.preventDefault(); closeMonthDeletion(); return }
  if (event.key === 'Escape' && showGenerate.value && generating.value) { event.preventDefault(); return }
  if (event.key === 'Escape') { editing.value = null; calendarDate.value = ''; showGenerate.value = false; showBackup.value = false; showHelp.value = false; importCandidate.value = null; mobileNav.value = false }
  if (event.key === 'Tab') {
    const modal = document.querySelector('.sp-modal')
    const controls = modal ? [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary')].filter(e => e.offsetParent !== null) : []
    if (controls.length) {
      const first = controls[0]!, last = controls[controls.length - 1]!
      if (event.shiftKey && (document.activeElement === first || !modal?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !modal?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    } else if (modal instanceof HTMLElement && generating.value) { event.preventDefault(); modal.focus({ preventScroll: true }) }
  }
}
onMounted(() => { if (desktop) void checkEngine(); document.title = 'Shift Schedule Expert'; window.addEventListener('keydown', escapeKey); window.addEventListener('pagehide', flushSave) })
onUnmounted(() => { disposed = true; unlistenProgress?.(); unlistenProgress = null; if (activeRequestId) void cancelDesktop(activeRequestId).catch(() => {}); window.clearInterval(generationTimer); flushSave(); window.removeEventListener('keydown', escapeKey); window.removeEventListener('pagehide', flushSave); worker?.terminate(); window.clearTimeout(workerTimer); window.clearTimeout(saveTimer); window.clearTimeout(noticeTimer) })
watch([editing, calendarDate, showGenerate, showBackup, showHelp, importCandidate], async () => { await nextTick(); (document.querySelector('.sp-modal input, .sp-modal select, .sp-modal button') as HTMLElement | null)?.focus() })
watch(monthDeletion, async target => { if (target) { await nextTick(); cancelMonthDeletionButton.value?.focus({ preventScroll: true }) } })
watch([generating, section, importCandidate], () => { if (monthDeletion.value) closeMonthDeletion(false); calendarReset.value = null }, { flush: 'sync' })
watch([generating, section], () => {
  if ((generating.value || section.value !== 'calendar') && (readingRules.value || rulesImportCandidate.value)) cancelRulesImport()
}, { flush: 'sync' })
watch(calendarDate, () => { calendarReset.value = null }, { flush: 'sync' })
watch([generating, cancelling], async () => {
  await nextTick()
  if (!showGenerate.value || !generating.value) return
  const modal = document.querySelector<HTMLElement>('.sp-generate-modal')
  ;(modal?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? modal)?.focus({ preventScroll: true })
})
</script>

<template>
  <IntegrationSettings v-if="showIntegrationSettings" :integration="integration" @close="showIntegrationSettings = false" />
  <div class="sp-app" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
    <button v-if="mobileNav" class="sp-nav-scrim" aria-label="关闭导航" @click="mobileNav = false"></button>
    <aside id="sp-app-sidebar" class="sp-sidebar" :class="{ 'is-open': mobileNav }">
      <a class="sp-brand" href="#" aria-label="Shift Schedule Expert" title="Shift Schedule Expert" @click.prevent="chooseSection('calendar')"><img :src="brandMarkUrl" alt="" width="40" height="40" /><span class="sp-brand-name"><strong>Shift Schedule</strong><b>Expert</b></span></a>
      <nav aria-label="应用导航"><button v-for="item in navigation" :key="item.key" :class="{ active: section === item.key }" :aria-label="item.label" :title="item.key === 'team' ? `${item.label}（${state.employees.length} 人）` : item.label" :aria-current="section === item.key ? 'page' : undefined" @click="chooseSection(item.key)"><Icon :name="item.icon" /><span class="sp-nav-label">{{ item.label }}</span><span v-if="item.key === 'team'" class="sp-nav-count">{{ state.employees.length }}</span></button></nav>
      <div class="sp-sidebar-bottom"><button class="sp-help" aria-label="备份与恢复" title="备份与恢复" @click="showBackup = true; mobileNav = false"><Icon name="file" :size="18" /><span class="sp-nav-label">备份与恢复</span></button><button class="sp-help" aria-label="使用帮助" title="使用帮助" @click="showHelp = true; mobileNav = false"><Icon name="info" :size="18" /><span class="sp-nav-label">使用帮助</span></button></div>
    </aside>
    <div class="sp-main">
      <header class="sp-topbar">
        <div class="sp-breadcrumb"><button type="button" class="sp-sidebar-toggle sp-icon-button" :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'" :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'" :aria-expanded="!sidebarCollapsed" aria-controls="sp-app-sidebar" @click="toggleSidebar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path :d="sidebarCollapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'"/></svg></button><button class="sp-mobile-toggle sp-icon-button" aria-label="打开导航" :aria-expanded="mobileNav" aria-controls="sp-app-sidebar" @click="mobileNav = true"><Icon name="menu" /></button><strong>{{ sectionLabel }}</strong></div>
        <div class="sp-global-month" role="group" aria-label="所有面板共用排班月份">
          <button class="sp-icon-button" aria-label="上个月" :disabled="state.month === '0001-01'" @click="navigateMonth(-1)"><Icon class="sp-flip" name="arrow" :size="16" /></button>
          <MonthPicker :model-value="state.month" :schedule-statuses="monthScheduleStatuses" @update:model-value="changeMonth" />
          <button class="sp-icon-button" aria-label="下个月" :disabled="state.month === '9999-12'" @click="navigateMonth(1)"><Icon name="arrow" :size="16" /></button>
          <button class="sp-current-month" title="返回本月及今天所在周" @click="goToday">本月</button>
        </div>
        <div class="sp-top-actions"><span class="sp-save-indicator" :class="{ error: saveError }"><i></i>{{ saveError ? '保存异常' : savedAt ? `${savedAt} 已保存` : '本地保存' }}</span><span class="sp-build-version" title="北京时间 · 本次软件构建时间" :aria-label="`构建版本 ${BUILD_VERSION}`"><span>构建</span><code>{{ BUILD_VERSION }}</code></span><button type="button" class="sp-icon-button sp-settings-trigger" aria-label="设置" title="设置" aria-haspopup="dialog" @click="showIntegrationSettings = true"><Icon name="settings" :size="19" /></button></div>
      </header>
      <main class="sp-content">
        <div v-if="saveError" class="sp-banner sp-banner-warning" role="alert"><Icon name="info" /><span>{{ saveError }}</span><button @click="exportBackup">导出备份</button></div>
        <div v-if="dates.some(date => !info(date).verified)" class="sp-banner sp-banner-warning" role="status"><Icon name="calendar" /><span>{{ state.month.slice(0, 4) }} 年的假期安排或法定计薪口径待核对。未手动确认的日期暂按工作日和周末推算，请点击日期核对，或导入已有日历备份。</span></div>
        <div class="sp-page-heading"><div><h1>{{ sectionLabel }}</h1><p v-if="section === 'calendar'" class="sp-context"><span class="sp-schedule-action">{{ scheduleSource }}</span><span v-if="scheduleUpdate" class="sp-schedule-update" :data-schedule-source="scheduleUpdate.source" aria-label="本月最近外部排班生成或更新时间"><span>最近 {{ scheduleUpdate.source.toUpperCase() }} 排班生成 / 更新：</span><time :datetime="scheduleUpdate.at" title="软件成功保存该月份外部排班数据的时间（本机时间）">{{ formatChangeTime(scheduleUpdate.at) }}</time><small>本机时间</small></span></p></div><div v-if="section === 'calendar'" class="sp-heading-actions"><button class="sp-button" :disabled="generating || readingRules || !!rulesImportCandidate" title="导入之前导出的规则文件" @click="openRulesImport"><Icon name="upload" :size="17" />{{ readingRules ? '正在读取…' : '导入规则' }}</button><button class="sp-button" title="导出成员、班次、规则和相关排班记录" @click="exportRules()"><Icon name="file" :size="17" />导出规则</button><button class="sp-button" @click="exportExcel"><Icon name="download" :size="17" />导出 Excel</button><button v-if="section === 'calendar'" class="sp-button sp-primary" :disabled="generating || (desktop && engineState === 'checking')" @click="showGenerate = true"><Icon :name="generating ? 'clock' : 'spark'" :size="18" />{{ generating ? '正在排班…' : desktop && engineState === 'checking' ? '正在准备…' : '自动排班' }}</button></div></div>
        <div v-if="rulesImportError && !rulesImportCandidate" class="sp-rules-import-error" role="alert"><span>{{ rulesImportError }}</span><button type="button" aria-label="关闭规则导入提示" @click="rulesImportError = ''">×</button></div>
        <section v-if="externalChange" class="sp-external-change" role="status" aria-label="外部配置变更提醒">
          <Icon name="info" :size="20" />
          <div>
            <strong>外部修改了配置，请核对现有排班</strong>
            <p>最近修改来自 {{ externalChange.source.toUpperCase() }} · {{ formatChangeTime(externalChange.at) }}。待核对：{{ externalChange.categories.join('、') }}。</p>
            <p>配置修改不会自动重新排班。{{ issues.length ? `当前月份检查出 ${issues.length} 项冲突或提醒，请查看并按需重新生成。` : '当前月份未发现规则冲突，请确认其他月份和配置是否符合预期。' }}</p>
            <div class="sp-external-actions">
              <button class="sp-button" @click="reviewExternalChanges">查看排班检查</button>
              <button class="sp-button" :disabled="generating" @click="acknowledgeExternalChanges">已核对变更</button>
            </div>
          </div>
        </section>
        <div v-if="section === 'calendar' && desktop && engineState !== 'ready'" class="sp-engine-strip" :class="{ 'is-error': engineState === 'error' }"><span role="status"><Icon name="info" :size="16" />{{ engineInfo }}</span><button v-if="engineState === 'error'" class="sp-link" @click="showGenerate = true">检测与重试</button></div>
        <div v-if="section === 'calendar' && solverFeedback" class="sp-solve-result" :class="{ 'is-warning': !solverFeedback.success || solverFeedback.stale }" role="status">
          <Icon :name="solverFeedback.success && !solverFeedback.stale ? 'shield' : 'info'" :size="20" />
          <div>
            <strong>{{ solverFeedback.stale ? '配置已更改，上次排班结果需要重新检查' : solverFeedback.message }}</strong>
            <p v-if="solverFeedback.stale" class="sp-diagnostic-stale">设置已更改，下方提示仍对应上一次排班；请重新生成以检查修改。</p>
            <p v-for="(detail,index) in solverFeedback.details" :key="index">{{ detail }}</p>
            <ol v-if="solverFeedback.issues.length" class="sp-conflict-list">
              <li v-for="(issue,index) in (expandedFeedback ? solverFeedback.issues : solverFeedback.issues.slice(0,5))" :key="`${issue.id}-${index}`">
                <span>{{ issue.message }}</span>
                <p v-if="issue.suggestion" class="sp-conflict-suggestion">建议：{{ issue.suggestion }}</p>
                <button v-if="diagnosticActionLabel(issue)" class="sp-link" @click="openDiagnostic(issue)">{{ diagnosticActionLabel(issue) }} →</button>
              </li>
            </ol>
            <button v-if="solverFeedback.issues.length > 5" class="sp-link" @click="expandedFeedback = !expandedFeedback">{{ expandedFeedback ? '收起部分问题' : `查看其余 ${solverFeedback.issues.length - 5} 项问题` }}</button>
            <div v-if="!solverFeedback.success && solverFeedback.attempt" class="sp-diagnostic-actions">
              <button class="sp-button" @click="exportRules(solverFeedback.attempt)"><Icon name="download" :size="15" />导出本次规则</button>
              <span>保留 {{ solverFeedback.attempt.request.state.month }} 当次的完整设置和锁定安排。</span>
            </div>
            <p v-if="solverFeedback.diagnostic" class="sp-solver-diagnostic">请重试；仍然无法使用时，可重新打开应用或更新到最新版本。</p>
          </div>
          <button class="sp-icon-button" aria-label="关闭排班结果" @click="solverFeedback = null"><Icon name="close" :size="16" /></button>
        </div>
        <dl v-if="section === 'calendar'" class="sp-overview" aria-label="本月排班概览">
          <div><dt>需求覆盖</dt><dd>{{ coverage.percentage }}<small>%</small></dd><span :class="coverage.percentage === 100 && !coverage.excess ? 'sp-text-green' : 'sp-text-amber'">{{ coverage.excess ? `固定班次超出 ${coverage.excess} 人次，请调整` : coverage.percentage === 100 ? `${coverage.filled} 个需求班位已满足` : `缺 ${coverage.total - coverage.filled} 个班位` }}</span></div>
          <div><dt>参与成员</dt><dd>{{ state.employees.length }}<small>人</small></dd><span>{{ state.shifts.length }} 种班次</span></div>
          <div><dt>计划工时</dt><dd>{{ totalHours.toLocaleString('zh-CN') }}<small>h</small></dd><span>{{ lockedCount }} 项已锁定</span></div>
        </dl>
        <p v-if="payrollError && section === 'calendar'" class="sp-calculation-error" role="alert">津贴无法计算：{{ payrollError }}。调整配置前不会导出金额。</p>
        <template v-if="section === 'calendar'">
          <section class="sp-calendar-card" aria-label="人员排班表" tabindex="-1">
            <div class="sp-calendar-toolbar">
              <div class="sp-date-controls"><span class="sp-month-label"><Icon name="calendar" :size="19" /><span>{{ monthTitle }}</span></span><div v-if="view === 'week'" class="sp-arrows"><button class="sp-icon-button" aria-label="上一时段" title="本月上一周" :disabled="weekIndex === 0" @click="navigatePeriod(-1)"><Icon class="sp-flip" name="arrow" :size="16" /></button><button class="sp-icon-button" aria-label="下一时段" title="本月下一周" :disabled="weekIndex >= weekCount - 1" @click="navigatePeriod(1)"><Icon name="arrow" :size="16" /></button></div><span class="sp-period">{{ period }}</span></div>
              <div class="sp-calendar-actions"><div class="sp-view-toggle" aria-label="日历视图"><button :class="{ active: view === 'week' }" @click="view = 'week'">周视图</button><button :class="{ active: view === 'month' }" @click="view = 'month'">月视图</button></div><button ref="deleteMonthButton" type="button" class="sp-icon-button sp-delete-month" aria-label="删除本月排班" :title="`删除 ${monthTitle}的排班`" :disabled="generating || !monthEntryCount" @click="requestMonthDeletion"><Icon name="trash" :size="18" /></button></div>
            </div>
            <div class="sp-filterbar"><div class="sp-filters"><label class="sp-search"><Icon name="search" :size="16" /><input v-model="employeeQuery" placeholder="搜索成员" aria-label="搜索成员" /></label><AppSelect v-model="groupFilter" class="sp-group-filter" label="按工作组筛选" :options="[{ value: '', label: '全部工作组' }, ...groups.map(group => ({ value: group, label: group }))]" /></div><div class="sp-legend"><span v-for="s in state.shifts" :key="s.id"><i :style="{ background: s.color }"></i>{{ s.name }}</span><span><i class="sp-leave-dot"></i>请假</span><button class="sp-icon-button" :disabled="!history.length" aria-label="撤销上次调整" @click="undo"><Icon name="undo" :size="16" /></button></div></div>
            <p id="employee-order-help" class="sp-employee-order-assist">拖动姓名左侧手柄调整人员顺序，成员管理同步。也可聚焦手柄按空格开始，用上下方向键选择位置，回车或空格保存，Escape 取消。筛选时仅调整可见成员，其他成员位置保持。</p>
            <p class="sp-employee-order-assist" role="status" aria-live="polite" aria-atomic="true">{{ employeeReorder.announcement.value }}</p>
            <div class="sp-table-scroll" tabindex="0" aria-label="可横向滚动的排班表">
              <table ref="employeeTable" class="sp-schedule-table" :class="{ 'sp-month-table': view === 'month', 'is-reordering-employees': employeeReorder.active.value }">
                <thead><tr>
                  <th class="sp-person-col"><span>团队成员</span><small>{{ employees.length }} 位成员 · 拖动排序</small></th>
                  <th v-for="date in visibleDates" :key="date" :class="{ 'sp-current-day': date === today, 'sp-restday': info(date).kind === 'restday' }"><button class="sp-date-heading" :aria-label="`设置 ${date} 日期类型`" @click="openDate(date)"><span>周{{ weekday(date) }}</span><strong>{{ Number(date.slice(8)) }}<i v-if="date === today"></i></strong><small v-if="info(date).kind === 'statutory'" class="sp-holiday">{{ info(date).label }}</small><small v-else-if="info(date).label.includes('调休') || info(date).label.includes('补班')">{{ info(date).label }}</small><small v-else>{{ date === today ? '今天' : ' ' }}</small></button></th>
                  <th class="sp-hours-col" title="仅计算实际落在本月的工时，包括上月夜班进入本月的部分">本月工时</th>
                  <th class="sp-allowance-col" title="按本月开始的班次数累计固定津贴">额外津贴<small>当月合计 · 元</small></th>
                </tr></thead>
                <tbody>
                  <tr v-for="employee in employees" :key="employee.id" :data-employee-id="employee.id" :data-drop-position="employeeReorder.dropPosition(employee.id)" :class="{ 'is-reordering': employeeReorder.sourceId.value === employee.id }">
                    <th class="sp-person-col"><div class="sp-person"><button type="button" class="sp-employee-drag-handle" :data-drag-employee-id="employee.id" :aria-label="`调整${employee.name}的显示顺序`" aria-describedby="employee-order-help" :aria-pressed="employeeReorder.sourceId.value === employee.id" title="拖动调整顺序；空格开始，上下键移动，回车保存，Escape 取消" :disabled="!canReorderEmployees || employees.length < 2" @pointerdown="employeeReorder.pointerdown(employee.id, employee.name, $event)" @keydown="employeeReorder.keydown(employee.id, employee.name, $event)" @click.stop.prevent><svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true" focusable="false"><g fill="currentColor"><circle cx="5" cy="5" r="1.4"/><circle cx="11" cy="5" r="1.4"/><circle cx="5" cy="10" r="1.4"/><circle cx="11" cy="10" r="1.4"/><circle cx="5" cy="15" r="1.4"/><circle cx="11" cy="15" r="1.4"/></g></svg></button><EmployeeAvatar class="sp-person-avatar" :name="employee.name" :color="employee.color" :avatar="employee.avatar" size="small" /><span><strong>{{ employee.name }}</strong><small>{{ employee.role }} · {{ employee.group }}</small></span></div></th>
                    <td v-for="date in visibleDates" :key="date" :class="{ 'sp-current-day': date === today }">
                      <button class="sp-shift-cell" :class="{ 'is-off': !findShift(entry(employee.id,date)?.shiftId || '') && !leave(employee,date), 'is-leave': leave(employee,date), 'has-allowance': (dayAllowance(employee.id,date)?.totalAllowance ?? 0) > 0 }" :style="findShift(entry(employee.id,date)?.shiftId || '') && !leave(employee,date) ? { background: findShift(entry(employee.id,date)!.shiftId)!.color } : {}" :aria-label="`${employee.name} ${date} ${leave(employee,date) ? '请假' : findShift(entry(employee.id,date)?.shiftId || '')?.name || '休息'}，点击编辑`" :aria-description="allowanceDescription(employee.id,date)" :title="allowanceDescription(employee.id,date)" @click="openCell(employee,date)">
                        <template v-if="leave(employee,date)"><span>请假</span><small>全天休假</small></template>
                        <template v-else-if="findShift(entry(employee.id,date)?.shiftId || '')"><span>{{ findShift(entry(employee.id,date)!.shiftId)!.name }}<Icon v-if="entry(employee.id,date)?.locked" name="lock" :size="10" /></span><small>{{ findShift(entry(employee.id,date)!.shiftId)!.start }}–{{ findShift(entry(employee.id,date)!.shiftId)!.end }}</small></template>
                        <template v-else-if="dayAllowance(employee.id,date)?.carriedShiftIds.length"><span>跨夜续班</span><small>来自前一天排班</small></template>
                        <template v-else><span>休息 <Icon v-if="entry(employee.id,date)?.locked" name="lock" :size="10" /></span><small class="sp-off-add">＋ 调整班次</small></template>
                        <span v-if="(dayAllowance(employee.id,date)?.totalAllowance ?? 0) > 0" class="sp-allowance-badge" :data-allowance="dayAllowance(employee.id,date)!.totalAllowance" :data-allowance-date="date" :data-allowance-employee="employee.id">＋¥{{ money(dayAllowance(employee.id,date)!.totalAllowance) }}</span>
                      </button>
                    </td>
                    <td class="sp-hours-col"><strong>{{ employeeHours(employee.id) }}<small> h</small></strong><span>{{ employeeDays(employee.id) }} 个班次</span></td>
                    <td class="sp-allowance-col" :data-employee-allowance="employee.id" :data-allowance="payrollError ? null : employeeAllowances.get(employee.id)?.totalAllowance ?? 0"><strong v-if="payrollError">无法计算</strong><template v-else><strong>¥{{ money(employeeAllowances.get(employee.id)?.totalAllowance ?? 0) }}</strong><span>按班次固定金额累计</span></template></td>
                  </tr>
                  <tr v-if="!employees.length"><td :colspan="visibleDates.length+3" class="sp-empty">没有找到成员，请修改筛选条件或添加成员。</td></tr>
                </tbody>
                <tfoot>
                  <tr><th class="sp-person-col">每日覆盖<small class="sp-coverage-caption"><span>已安排 / 最低人数</span><InfoTip label="最低安排人数说明"><strong>规则要求的每日最低安排人数</strong><p>将各班次的“每日最少”或“每日固定”人数相加，当前每天至少安排 {{ requiredPerDay }} 人。</p><p>实际增派只增加左侧“已安排”，不会抬高右侧最低人数。固定班次仍须恰好满足，各班次不能相互抵消缺口。</p><p>均按当天全团队统计，不随成员筛选变化。个人月／周最低工时另行检查。</p></InfoTip></small></th><td v-for="date in visibleDates" :key="date"><span :class="dailyCovered(date) ? 'sp-text-green' : 'sp-text-amber'">{{ dailyFilled(date) }} <small>/ {{ requiredPerDay }}</small></span></td><td class="sp-hours-col">{{ totalHours }} h</td><td class="sp-allowance-col">—</td></tr>
                  <tr class="sp-allowance-footer"><th class="sp-person-col">津贴合计<small>当前筛选成员</small></th><td v-for="date in visibleDates" :key="date">¥{{ payrollError ? '—' : money(dailyAllowanceTotal(date)) }}</td><td class="sp-hours-col">当月汇总 →</td><td class="sp-allowance-col" :data-allowance-total="payrollError ? null : filteredAllowanceTotal"><strong>¥{{ payrollError ? '—' : money(filteredAllowanceTotal) }}</strong></td></tr>
                </tfoot>
              </table>
            </div>
            <p class="sp-allowance-legend"><span aria-hidden="true">✦</span> 金色金额为该班次的固定津贴，排一次领取一份。跨夜班全部津贴记在开始日期，只领一次。右侧汇总整月金额。</p>
            <div class="sp-calendar-bottom"><span><Icon name="lock" :size="14" />点击班次调整，锁定后自动排班保留</span><button class="sp-check-status" :class="{ warning: issues.length }" :aria-expanded="showIssues" @click="showIssues = !showIssues"><Icon :name="issues.length ? 'info' : 'shield'" :size="15" />{{ issues.length ? `${issues.length} 项排班提醒` : '排班检查通过' }}<Icon name="arrow" :size="13" /></button></div>
          </section>
          <div v-if="showIssues" class="sp-issues"><template v-if="issues.length"><button v-for="issue in issues.slice(0, 100)" :key="issue.id" @click="jumpToIssue(issue.date)"><span :class="issue.severity">{{ issue.severity === 'error' ? '冲突' : '提醒' }}</span><span>{{ issue.message }}</span><small v-if="issue.date">{{ issue.date }} ↗</small></button><p v-if="issues.length > 100">还有 {{ issues.length - 100 }} 项，请先处理当前提醒。</p></template><p v-else>休假、班次资格、周工时上下限、连续工作和休息间隔均通过检查。<button class="sp-link" @click="chooseSection('rules')">自定义规则 →</button></p></div>
        </template>

        <SettingsPanel v-if="section !== 'calendar'" ref="settingsPanel" :state="state" :section="section" :payroll="state.payroll" @change="settingsChanged" />
      </main>
    </div>

    <input v-if="!desktop" ref="importer" class="sp-hidden" type="file" accept=".json,application/json" @change="selectImport" />
    <input v-if="!desktop" ref="rulesImporter" class="sp-hidden" type="file" accept=".json,application/json" aria-label="导入规则文件" @change="selectRulesImport" @cancel="cancelRulesImport" />
    <div v-if="notice" class="sp-toast" role="status"><Icon name="info" :size="18" />{{ notice }}<button aria-label="关闭提示" @click="notice = ''"><Icon name="close" :size="15" /></button></div>

    <div v-if="monthDeletion" class="sp-overlay" @click.self="closeMonthDeletion()">
      <section class="sp-modal sp-delete-month-modal" role="dialog" aria-modal="true" aria-labelledby="sp-delete-month-title" aria-describedby="sp-delete-month-description">
        <div class="sp-modal-heading"><h2 id="sp-delete-month-title">删除 {{ deletionMonthTitle }}排班？</h2><button type="button" class="sp-icon-button" aria-label="关闭删除排班确认" @click="closeMonthDeletion()"><Icon name="close" /></button></div>
        <p id="sp-delete-month-description" class="sp-modal-copy">将删除该月的 <strong>{{ monthDeletion.count }} 条</strong>排班记录，包括其中已锁定的安排和休息记录。</p>
        <p class="sp-modal-copy">按班次开始日期归属月份，跨夜班也归入开始的月份。请假日期、成员、班次、规则和其他月份的排班均保留。</p>
        <p class="sp-modal-note">删除后可以通过排班表中的“撤销上次调整”恢复。</p>
        <div class="sp-modal-actions"><button ref="cancelMonthDeletionButton" type="button" class="sp-button" @click="closeMonthDeletion()">取消</button><button type="button" class="sp-button sp-delete-month-confirm" :disabled="generating" @click="confirmMonthDeletion">确认删除</button></div>
      </section>
    </div>

    <ConfirmDialog v-if="calendarReset" :title="`恢复 ${calendarReset.date} 的默认日期类型？`" description="将删除这一天的手动日期设置，恢复系统日历判定；可能改变所在月份的自动参考工时。已有排班保持不变。" confirm-label="确认恢复" @cancel="calendarReset = null" @confirm="confirmCalendarReset" />

    <div v-if="editing" class="sp-overlay" @click.self="editing = null"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-edit-title"><div class="sp-modal-heading"><div><h2 id="sp-edit-title">调整班次</h2><p>{{ editing.employee.name }} · {{ editing.date }} · 周{{ weekday(editing.date) }}</p></div><button class="sp-icon-button" aria-label="关闭班次编辑" @click="editing = null"><Icon name="close" /></button></div><div class="sp-shift-options"><button v-for="s in state.shifts" :key="s.id" :disabled="!editing.employee.eligibleShiftIds.includes(s.id)" :class="{ selected: editing.shiftId === s.id }" @click="editing.shiftId = s.id"><span class="sp-shift-swatch" :style="{ background: s.color }">{{ s.shortName }}</span><span><strong>{{ s.name }}</strong><small>{{ s.start }}–{{ s.end }} · {{ shiftHours(s) }} 小时{{ editing.employee.eligibleShiftIds.includes(s.id) ? '' : ' · 未获得该班资格' }}</small></span><Icon v-if="editing.shiftId === s.id" name="check" /></button><button :class="{ selected: editing.shiftId === 'off' }" @click="editing.shiftId = 'off'"><span class="sp-shift-swatch">休</span><span><strong>安排休息</strong><small>锁定后，自动排班不会占用这一天</small></span></button><button :class="{ selected: editing.shiftId === 'leave' }" @click="editing.shiftId = 'leave'"><span class="sp-shift-swatch sp-leave-swatch">假</span><span><strong>全天请假</strong><small>作为不可排班日期保存</small></span></button></div><div class="sp-edit-allowance" role="note"><strong>已保存排班的当日津贴</strong><p>{{ allowanceDescription(editing.employee.id, editing.date) }}</p><small>保存班次调整后会重新计算。</small></div><label v-if="editing.shiftId !== 'leave'" class="sp-lock-toggle"><input v-model="editing.locked" type="checkbox" /><Icon name="lock" :size="15" /><span>锁定本次安排，重新排班时保留</span></label><div class="sp-modal-actions"><button class="sp-button" @click="editing = null">取消</button><button class="sp-button sp-primary" @click="saveCell">保存安排</button></div></section></div>

    <div v-if="calendarDate" class="sp-overlay" @click.self="calendarDate = ''"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-date-title"><div class="sp-modal-heading"><div><h2 id="sp-date-title">{{ calendarDate }} · 日期类型</h2><p>该设置用于日历标记；津贴按排班领取固定金额。</p><SourceBadge :state="state" :path="`calendar.${calendarDate}`" /></div><button class="sp-icon-button" aria-label="关闭日期设置" @click="calendarDate = ''"><Icon name="close" /></button></div><div class="sp-shift-options"><button v-for="option in [{kind:'workday',label:'正常工作日 / 调休补班',note:'在日历中标记为工作日'},{kind:'restday',label:'休息日',note:'在日历中标记为休息日'},{kind:'statutory',label:'法定节假日',note:'仅标记日期类型，不自动增加津贴'}]" :key="option.kind" :class="{ selected: calendarKind === option.kind }" @click="calendarKind = option.kind as DayKind"><span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span><Icon v-if="calendarKind === option.kind" name="check" /></button></div><p class="sp-modal-note">{{ info(calendarDate).verified ? '当前日期已采用库内日历或人工确认。' : '该日期待核对，请核对工作日安排后设置。' }}{{ info(calendarDate).source }}</p><div class="sp-modal-actions"><button class="sp-button" :disabled="!Object.hasOwn(state.calendar, calendarDate)" @click="requestCalendarReset">恢复默认</button><button class="sp-button sp-primary" @click="saveCalendar()">确认日期类型</button></div></section></div>

    <div v-if="showGenerate" class="sp-overlay" @click.self="!generating && (showGenerate = false)">
      <section class="sp-modal sp-generate-modal" role="dialog" aria-modal="true" aria-labelledby="sp-generate-title" tabindex="-1">
        <div class="sp-modal-heading"><h2 id="sp-generate-title">为 {{ generationMonthTitle }} 生成排班</h2><button v-if="!generating" class="sp-icon-button" aria-label="关闭自动排班" @click="showGenerate = false"><Icon name="close" /></button></div>
        <template v-if="generating">
          <p v-if="externalGeneration" class="sp-external-generation-context" role="note" aria-label="外部排班生成任务">{{ externalGeneration.source.toUpperCase() }} 正在生成 {{ externalGeneration.month }} 排班<span v-if="externalGeneration.month !== state.month"> · 当前查看月份保持不变</span></p>
          <div class="sp-solve-progress sp-generation-progress">
            <span class="sp-solve-spinner" aria-hidden="true"></span>
            <div>
              <strong role="status" aria-live="polite">{{ cancelling ? '正在取消排班…' : cancellationError ? '取消尚未完成' : solverPhaseLabels[solvePhase] }}</strong>
              <p class="sp-generation-solutions" aria-live="polite" aria-atomic="true">已获取方案 <b data-solution-count>{{ solutionCount }}</b> 种</p>
              <p class="sp-generation-timing" aria-live="off"><span>总计 <span data-elapsed-seconds>{{ elapsedSeconds }}</span> 秒</span><span>· 当前阶段 <span data-phase-seconds>{{ phaseSeconds }}</span> 秒</span><span>· 完成前保留原表</span></p>
              <p>搜索时限 {{ externalGeneration?.timeLimitSeconds ?? (desktop ? solveTimeLimit : 30) }} 秒；时限内继续搜索优化，结束后校验并采用优选结果。</p>
            </div>
          </div>
          <p v-if="cancellationError" class="sp-generation-cancel-error" role="alert">{{ cancellationError }}</p>
          <div class="sp-modal-actions"><button class="sp-button" :disabled="cancelling" @click="cancelGeneration">{{ cancelling ? '正在取消…' : cancellationError ? '重试取消' : '取消排班' }}</button></div>
        </template>
        <template v-else>
        <div class="sp-generation-summary"><Icon name="spark" :size="35" /><div><strong>{{ state.employees.length }} 位成员 · {{ state.shifts.length }} 个班次</strong><p>需求 {{ coverage.total }} 个班位 · 保留 {{ lockedCount }} 项锁定安排</p></div></div>
        <p class="sp-modal-copy">按成员工时、请假和已设置规则重新安排本月未锁定班次。每日最少人数可增派；每日固定人数须恰好满足。</p>
        <div v-if="openingWeekInfo" class="sp-opening-week-note" role="note" aria-label="月初跨周排班说明" :data-history-included="openingWeekInfo.included"><strong>{{ openingWeekInfo.title }}</strong><span v-if="openingWeekInfo.range" class="sp-opening-week-range">{{ openingWeekInfo.range }}</span><p>{{ openingWeekInfo.summary }}</p></div>
        <template v-if="desktop">
          <div class="sp-solver-engine" :class="{ 'is-error': engineState === 'error' }"><Icon :name="engineState === 'ready' ? 'shield' : 'info'" :size="18" /><span><strong>{{ engineState === 'ready' ? '已准备就绪' : engineState === 'error' ? '暂时无法排班' : '正在准备' }}</strong><small role="status">{{ engineInfo }}</small></span><button v-if="engineState === 'error'" class="sp-button" @click="checkEngine">重试检测</button></div>
          <p v-if="engineDiagnostic" class="sp-solver-diagnostic">请先重试；仍然无法使用时，可重新打开应用或更新到最新版本。</p>
          <details class="sp-generation-advanced"><summary>高级选项<span>最长等待 {{ solveTimeLimit }} 秒</span></summary>
            <div class="sp-solver-options">
              <div class="sp-solver-time">
                <div class="sp-solver-time-caption"><span>最长等待时间</span><InfoTip label="最长等待时间说明">
                  <strong>给排班搜索多少时间？</strong>
                  <p>这是搜索和优化排班的时间上限，提前完成会提前返回。启动和结果校验还需额外时间。</p>
                  <p>延长时间可能找到更均衡的工时和班次分配，但不保证结果更好，15 秒与 60 秒也可能得到相同结果。</p>
                  <p>休息间隔、连续工作天数等规则始终必须满足；延长时间不会放宽规则，也无法解决规则本身的冲突。</p>
                  <p>建议先用 15 秒；提示暂未找到方案时，再试 60 秒。</p>
                </InfoTip></div>
                <AppSelect class="sp-solve-time-select" :model-value="String(solveTimeLimit)" label="最长等待时间" :options="[5,15,30,60].map(seconds => ({ value: String(seconds), label: `${seconds} 秒` }))" @update:model-value="solveTimeLimit = Number($event)" />
              </div>
            </div>
          </details>
        </template>
        <p class="sp-modal-note">人数和其他规则都满足后才会替换本月排班。未完成时保留原表，生成后可以撤销。</p>
        <div class="sp-modal-actions"><button class="sp-button" @click="showGenerate = false">取消</button><button class="sp-button sp-primary" :disabled="desktop && engineState !== 'ready'" @click="generate"><Icon name="spark" :size="17" />{{ desktop && engineState === 'checking' ? '正在准备…' : '开始生成' }}</button></div>
        </template>
      </section>
    </div>

    <div v-if="showBackup" class="sp-overlay" @click.self="showBackup = false"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-backup-title"><div class="sp-modal-heading"><div><h2 id="sp-backup-title">备份与恢复</h2><p>数据保存在{{ storageLocation }}，不会自动云同步。</p></div><button class="sp-icon-button" aria-label="关闭备份面板" @click="showBackup = false"><Icon name="close" /></button></div><div class="sp-shift-options"><button @click="exportBackup"><Icon name="download" /><span><strong>导出完整备份</strong><small>JSON 文件，可在另一台设备恢复</small></span><Icon name="arrow" :size="16" /></button><button @click="openImport"><Icon name="upload" /><span><strong>导入备份文件</strong><small>确认后替换当前工作空间，建议先导出备份</small></span><Icon name="arrow" :size="16" /></button></div></section></div>

    <ConfirmDialog v-if="rulesImportCandidate" title="导入这个规则文件？" description="将用文件中的成员、班次、排班规则和所有月份排班替换当前工作空间。日期类型和津贴设置也按文件恢复。" confirm-label="确认导入" @confirm="confirmRulesImport" @cancel="cancelRulesImport">
      <div class="sp-rules-import-preview">
        <p class="sp-rules-import-file">{{ rulesImportCandidate.name }}</p>
        <strong>{{ rulesImportCandidate.parsed.document.teamName }} · {{ rulesImportCandidate.parsed.document.month }}</strong>
        <dl>
          <div><dt>成员</dt><dd>{{ rulesImportCandidate.parsed.document.employees.length }} 人</dd></div>
          <div><dt>班次</dt><dd>{{ rulesImportCandidate.parsed.document.shifts.length }} 种</dd></div>
          <div><dt>所有月份排班</dt><dd>{{ rulesImportCandidate.parsed.document.assignments.length }} 条</dd></div>
          <div><dt>其中锁定安排</dt><dd>{{ rulesImportCandidate.parsed.document.assignments.filter(item => item.locked).length }} 条</dd></div>
        </dl>
        <p>班间休息至少 {{ rulesImportCandidate.parsed.document.rules.minRestHours }} 小时，连续工作最多 {{ rulesImportCandidate.parsed.document.rules.maxConsecutiveDays }} 天。</p>
        <p>班次不相连 {{ rulesImportCandidate.parsed.document.rules.nonConsecutiveShifts?.length ?? 0 }} 条 · 周班次限制 {{ rulesImportCandidate.parsed.document.rules.weeklyShiftLimits?.length ?? 0 }} 条 · 人员互斥 {{ rulesImportCandidate.parsed.document.rules.separationGroups?.length ?? 0 }} 组 · 上班权重{{ rulesImportCandidate.parsed.document.rules.weekdayWeights ? '开启' : '关闭' }}。</p>
        <p v-if="rulesImportCandidate.parsed.timeLimitSeconds !== undefined">自动排班等待时长：{{ rulesImportCandidate.parsed.timeLimitSeconds }} 秒。</p>
      </div>
      <p v-if="rulesImportCandidate.parsed.source === 'attempt'">这是当次自动排班使用的设置和原有安排，导入后可重新生成排班。</p>
      <p v-if="rulesImportCandidate.parsed.document.calendar === undefined || rulesImportCandidate.parsed.document.payroll === undefined">该文件缺少的日期类型或津贴设置将使用默认值。</p>
      <p>规则导出不含头像，仍对应的成员会保留本机头像。有变化的配置将记录为手动修改及本次导入时间。</p>
      <p class="sp-rules-import-note">导入后请查看排班检查结果，需要时重新生成排班。</p>
      <p v-if="rulesImportError" class="sp-rules-import-error" role="alert">{{ rulesImportError }}</p>
    </ConfirmDialog>

    <div v-if="importCandidate" class="sp-overlay"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-import-title"><h2 id="sp-import-title">确认恢复这个工作空间？</h2><p class="sp-modal-copy">{{ importCandidate.teamName }} · {{ importCandidate.month }}<br />{{ importCandidate.employees.length }} 位成员、{{ importCandidate.shifts.length }} 种班次。导入将替换当前数据。</p><div class="sp-modal-actions"><button class="sp-button" @click="importCandidate = null">取消</button><button class="sp-button sp-primary" @click="confirmImport">确认导入</button></div></section></div>

    <div v-if="showHelp" class="sp-overlay" @click.self="showHelp = false">
      <section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-help-title">
        <div class="sp-modal-heading"><h2 id="sp-help-title">几步，安排好下个月</h2><button class="sp-icon-button" aria-label="关闭帮助" @click="showHelp = false"><Icon name="close" /></button></div>
        <ol class="sp-help-list">
          <li><strong>添加团队成员</strong><p>设置每人的周最低/最高工时、班次资格和请假日期。</p></li>
          <li><strong>定义班次和规则</strong><p>设置班次时间及每日人数：选“最少”可增派，选“固定”须恰好满足。再设置休息间隔与连续工作天数；也可逐条指定不连续的班次及每人每周次数上限。</p></li>
          <li><strong>选择月份，自动生成</strong><p>顶部月份在所有面板共用。点击日历格子调整或锁定安排，冲突会显示在表格下方。</p></li>
          <li><strong>设置班次津贴</strong><p>在「班次设置」填写每人每班的固定津贴。排一次领取一份，跨夜只计一次；排班表金色金额与右侧月汇总实时更新。</p></li>
          <li><strong>导入规则、导出 Excel 和备份</strong><p>“导入规则”可恢复之前“导出规则”或“导出本次规则”保存的成员、班次、设置和排班记录。导入前会显示预览，确认后替换当前工作空间。Excel 用于查看分享，包含头像的完整迁移请使用备份与恢复。首次进入展示的是可编辑示例团队。</p></li>
        </ol>
        <figure class="sp-help-qrcode">
          <img :src="helpQrCodeUrl" alt="公众号二维码" width="258" height="258" />
          <figcaption>扫码关注公众号</figcaption>
        </figure>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sp-external-generation-context { margin: 0 0 14px; color: #527663; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.sp-opening-week-note { margin-top: 12px; padding: 10px 12px; border-left: 3px solid #94b5a2; border-radius: 5px; background: #f3f7f4; color: #5c7869; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.sp-opening-week-note strong { color: #3e6753; font-size: 12px; font-weight: 600; }
.sp-opening-week-range { display: block; font-variant-numeric: tabular-nums; }
.sp-opening-week-note p { margin: 4px 0 0; }
</style>
