<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import SettingsPanel from './SettingsPanel.vue'
import { makeDefaultState } from './defaults'
import { datesOfMonth, shiftHours, validateSchedule } from './scheduler'
import { backupJSON, loadSaved, parseBackup, saveLocal, scheduleXLSX } from './storage'
import { calculatePayroll, createPayrollConfig, dayInfo, payrollRows } from './payroll'
import type { DayKind, PayrollConfig, PayrollResult } from './payroll'
import type { Assignment, Employee, Issue, PlannerState, Shift } from './domain'
import { desktop, solveDesktop, cancelDesktop, desktopSolverInfo, importDesktopBackup, exportDesktopFile, checkDesktopResult, listenSolverProgress, matchingSolverPhase, solverPhaseLabels, formatSolverError } from './DesktopSolver'
import type { SolverRequest, SolverPhase } from './DesktopSolver'
import { BUILD_VERSION } from './buildInfo'
import { minimumMonthHours, monthlyHoursByEmployee, resolveHoursState } from './hours.ts'
import { weightedWeeks, weightedDayRange } from './weekday-weights.ts'
import './planner.css'

const brandMarkUrl = `${import.meta.env.BASE_URL}brand-mark.png`

type Document = PlannerState & PayrollConfig
type Section = 'calendar' | 'team' | 'shifts' | 'rules' | 'payroll'
const notice = ref('')
const saveError = ref('')
let initial: PlannerState | null = null
try { initial = loadSaved() } catch (e) { saveError.value = `原有数据读取失败，未覆盖原存档。${e instanceof Error ? e.message : ''}` }
const state = ref<Document>({ ...makeInitial(), ...((initial || {}) as Partial<Document>) })
function makeInitial(): Document { return { ...(initial || makeDefaultState()), ...createPayrollConfig() } }
const section = ref<Section>('calendar')
const mobileNav = ref(false)
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
const generating = ref(false)
const cancelling = ref(false)
const solveTimeLimit = ref(15)
const allowPartial = ref(false)
const elapsedSeconds = ref(0)
const engineInfo = ref('正在检查本地求解器…')
const engineState = ref<'checking' | 'ready' | 'error'>(desktop ? 'checking' : 'ready')
const engineDiagnostic = ref(false)
const solvePhase = ref<SolverPhase>('starting')
const phaseSeconds = ref(0)
const solverFeedback = ref<{ success: boolean; message: string; details: string[]; diagnostic: boolean } | null>(null)
let phaseStartedAt = 0
let engineCheckPending = false
let unlistenProgress: (() => void) | null = null
let progressListenerPending: Promise<void> | null = null
const scheduleSource = ref(initial ? '已恢复保存的排班' : '可编辑示例排班')
const storageLocation = desktop ? '此设备' : '当前浏览器'
let activeRequestId: string | null = null
let generationTimer = 0
let disposed = false
const importer = ref<HTMLInputElement | null>(null)
const importCandidate = ref<Document | null>(null)
const editing = ref<{ employee: Employee; date: string; shiftId: string; locked: boolean } | null>(null)
const calendarDate = ref('')
const calendarKind = ref<DayKind>('workday')
const history = ref<{ assignments: Assignment[]; leaves: Record<string, string[]> }[]>([])
const savedAt = ref('')
const navigation: { key: Section; label: string; icon: string }[] = [
  { key: 'calendar', label: '排班日历', icon: 'calendar' }, { key: 'team', label: '成员管理', icon: 'people' },
  { key: 'shifts', label: '班次设置', icon: 'clock' }, { key: 'rules', label: '排班规则', icon: 'rules' },
  { key: 'payroll', label: '班次津贴', icon: 'wallet' },
]
const sectionLabel = computed(() => navigation.find(n => n.key === section.value)!.label)
const dates = computed(() => datesOfMonth(state.value.month))
const monthOffset = computed(() => (new Date(`${state.value.month}-01T12:00:00`).getDay() + 6) % 7)
const weekCount = computed(() => Math.ceil((dates.value.length + monthOffset.value) / 7))
const visibleDates = computed(() => view.value === 'month' ? dates.value : dates.value.slice(Math.max(0, weekIndex.value * 7 - monthOffset.value), Math.min(dates.value.length, weekIndex.value * 7 + 7 - monthOffset.value)))
const groups = computed(() => [...new Set(state.value.employees.map(e => e.group).filter(Boolean))])
const employees = computed(() => state.value.employees.filter(e => (!groupFilter.value || e.group === groupFilter.value) && `${e.name}${e.role}`.includes(employeeQuery.value.trim())))
const assignments = computed(() => new Map(state.value.assignments.map(a => [`${a.employeeId}:${a.date}`, a])))
const monthAssignments = computed(() => state.value.assignments.filter(a => a.date.startsWith(state.value.month) && a.shiftId !== 'off'))
const issues = computed(() => validateSchedule(state.value))
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
const weightWeeks = computed(() => weightedWeeks(state.value))
const weightByDate = computed(() => new Map(weightWeeks.value.flatMap(week => week.dates.map(date => [date, week] as const))))
const coverage = computed(() => {
  if (state.value.rules.weekdayWeights) {
    const total = weightWeeks.value.reduce((sum, week) => sum + week.totalTarget, 0)
    const filled = weightWeeks.value.reduce((sum, week) => sum + state.value.shifts.reduce((n, shift) => n + Math.min(week.shiftTargets[shift.id] ?? 0, monthAssignments.value.filter(a => week.dates.includes(a.date) && a.shiftId === shift.id).length), 0), 0)
    return { total, filled, percentage: total ? Math.round(filled / total * 100) : 100 }
  }
  const total = dates.value.length * requiredPerDay.value
  const filled = dates.value.reduce((sum, date) => sum + state.value.shifts.reduce((n, s) => n + Math.min(s.required, monthAssignments.value.filter(a => a.date === date && a.shiftId === s.id).length), 0), 0)
  return { total, filled, percentage: total ? Math.round(filled / total * 100) : 100 }
})
const lockedCount = computed(() => state.value.assignments.filter(a => a.date.startsWith(state.value.month) && a.locked).length)
const dayAllowances = computed(() => new Map(payroll.value.dailyRows.map(row => [`${row.employeeId}:${row.date}`, row])))
const employeeAllowances = computed(() => new Map(payroll.value.rows.map(row => [row.employeeId, row])))
const allowanceRecipients = computed(() => payroll.value.rows.filter(row => row.totalAllowance > 0).length)
const allowanceShiftCount = computed(() => monthAssignments.value.filter(a => (findShift(a.shiftId)?.normalAllowance ?? 0) > 0).length)
const filteredAllowanceTotal = computed(() => employees.value.reduce((sum, employee) => sum + Math.round((employeeAllowances.value.get(employee.id)?.totalAllowance ?? 0) * 100), 0) / 100)
const monthTitle = computed(() => `${state.value.month.slice(0, 4)} 年 ${Number(state.value.month.slice(5))} 月`)
const period = computed(() => view.value === 'month' ? '整月总览' : `${Number(visibleDates.value[0]?.slice(8))} 日 — ${Number(visibleDates.value.at(-1)?.slice(8))} 日`)

function info(date: string) { return dayInfo(date, state.value.calendar) }
function weekday(date: string) { return ['日', '一', '二', '三', '四', '五', '六'][new Date(`${date}T12:00:00`).getDay()] }
function findShift(id: string): Shift | undefined { return state.value.shifts.find(s => s.id === id) }
function entry(employeeId: string, date: string) { return assignments.value.get(`${employeeId}:${date}`) }
function leave(employee: Employee, date: string) { return employee.unavailableDates.includes(date) }
function employeeHours(id: string) { return Number((actualMonthHours.value.get(id) ?? 0).toFixed(2)) }
function employeeDays(id: string) { return monthAssignments.value.filter(a => a.employeeId === id).length }
function dailyFilled(date: string) { return monthAssignments.value.filter(a => a.date === date).length }
function dailyDemandRange(date: string): [number, number] {
  const week = weightByDate.value.get(date)
  return week ? weightedDayRange(week, date) : [requiredPerDay.value, requiredPerDay.value]
}
function dailyDemandLabel(date: string) { const [low, high] = dailyDemandRange(date); return low === high ? String(low) : `${low}–${high}` }
function dailyCovered(date: string) { const [low, high] = dailyDemandRange(date); const count = dailyFilled(date); return state.value.rules.weekdayWeights ? count >= low && count <= high : count >= low }
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
function flash(message: string) { notice.value = message; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => notice.value = '', 5500) }
function remember() { history.value.push({ assignments: clone(state.value.assignments), leaves: Object.fromEntries(state.value.employees.map(e => [e.id, [...e.unavailableDates]])) }); if (history.value.length > 10) history.value.shift() }
function undo() { const previous = history.value.pop(); if (previous) { state.value.assignments = previous.assignments; for (const e of state.value.employees) if (previous.leaves[e.id]) e.unavailableDates = previous.leaves[e.id]!; flash('已撤销上一次排班调整') } }
function chooseSection(value: Section) { section.value = value; mobileNav.value = false }
function changeMonth(value: string) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return; state.value.month = value; weekIndex.value = 0; history.value = [] }
function navigatePeriod(direction: number) {
  if (view.value === 'week' && weekIndex.value + direction >= 0 && weekIndex.value + direction < weekCount.value) { weekIndex.value += direction; return }
  const d = new Date(`${state.value.month}-15T12:00:00`); d.setMonth(d.getMonth() + direction)
  changeMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  if (view.value === 'week' && direction < 0) weekIndex.value = weekCount.value - 1
}
function goToday() { changeMonth(today.slice(0, 7)); weekIndex.value = weekOf(today) }
function openCell(employee: Employee, date: string) { const a = entry(employee.id, date); editing.value = { employee, date, shiftId: leave(employee, date) ? 'leave' : a?.shiftId || 'off', locked: a?.locked ?? true } }
function saveCell() {
  const edit = editing.value; if (!edit) return
  remember()
  state.value.assignments = state.value.assignments.filter(a => !(a.employeeId === edit.employee.id && a.date === edit.date))
  edit.employee.unavailableDates = edit.employee.unavailableDates.filter(d => d !== edit.date)
  if (edit.shiftId === 'leave') edit.employee.unavailableDates.push(edit.date)
  else state.value.assignments.push({ employeeId: edit.employee.id, date: edit.date, shiftId: edit.shiftId, locked: edit.locked })
  editing.value = null
  const conflict = issues.value.find(i => i.employeeId === edit.employee.id && (!i.date || i.date === edit.date))
  flash(conflict ? `已保存，请处理冲突：${conflict.message}` : '班次已更新，锁定班次会在重新生成时保留')
}
function openDate(date: string) { calendarDate.value = date; calendarKind.value = info(date).kind }
function saveCalendar(reset = false) { if (reset) delete state.value.calendar[calendarDate.value]; else state.value.calendar[calendarDate.value] = calendarKind.value; calendarDate.value = ''; flash('日期类型已更新，自动月参考工时已重新计算；津贴按排班领取固定金额') }
let worker: Worker | null = null
let workerTimer = 0
let revision = 0
function finishGeneration() {
  worker?.terminate(); worker = null
  window.clearTimeout(workerTimer); window.clearInterval(generationTimer)
  generating.value = false; cancelling.value = false; activeRequestId = null
}
function feedback(success: boolean, message: string, details: string[] = [], diagnostic = false) {
  solverFeedback.value = { success, message, details: [...new Set(details)].filter(detail => !message.includes(detail)), diagnostic }
  // The persistent result card is the sole announcement of solver outcomes.
  notice.value = ''; window.clearTimeout(noticeTimer)
}
async function ensureProgressListener() {
  if (unlistenProgress) return
  if (!progressListenerPending) progressListenerPending = listenSolverProgress(progress => {
    const phase = matchingSolverPhase(progress, activeRequestId)
    if (!disposed && generating.value && phase && phase !== solvePhase.value) {
      solvePhase.value = phase; phaseStartedAt = Date.now(); phaseSeconds.value = 0
    }
  }).then(unlisten => { if (disposed) unlisten(); else unlistenProgress = unlisten }).finally(() => { progressListenerPending = null })
  await progressListenerPending
}
async function checkEngine() {
  if (!desktop || disposed || engineCheckPending || generating.value) return
  engineCheckPending = true; engineState.value = 'checking'; engineDiagnostic.value = false
  engineInfo.value = '正在启动并检查本地求解器，首次加载可能需要一些时间…'
  try {
    await ensureProgressListener()
    if (disposed) return
    const info = await desktopSolverInfo()
    if (disposed) return
    if (info.engine !== 'ortools-cp-sat' || info.protocolVersion !== 1 || !info.version) throw new Error('求解器版本信息不兼容，请重新安装桌面版')
    engineInfo.value = `OR-Tools CP-SAT ${info.version} · 已通过本地启动检测`
    engineState.value = 'ready'
  } catch (error) {
    if (!disposed) { const failure = formatSolverError(error, 'startup'); engineInfo.value = failure.message; engineState.value = 'error'; engineDiagnostic.value = failure.diagnostic }
  } finally { engineCheckPending = false }
}
async function generate() {
  if (generating.value || (desktop && engineState.value !== 'ready')) return
  showGenerate.value = false; generating.value = true; cancelling.value = false
  solverFeedback.value = null; elapsedSeconds.value = 0; phaseSeconds.value = 0; solvePhase.value = 'starting'
  const started = Date.now(); phaseStartedAt = started
  generationTimer = window.setInterval(() => { elapsedSeconds.value = Math.floor((Date.now() - started) / 1000); phaseSeconds.value = Math.floor((Date.now() - phaseStartedAt) / 1000) }, 250)
  const input = resolveHoursState(clone(state.value)), inputRevision = revision
  const seed = Math.floor(Math.random() * 2147483647)
  if (desktop) {
    const request: SolverRequest = { protocolVersion: 1, requestId: crypto.randomUUID(), state: input, options: { timeLimitSeconds: solveTimeLimit.value, allowPartial: allowPartial.value, seed } }
    activeRequestId = request.requestId
    try {
      const result = await solveDesktop(request)
      if (disposed || activeRequestId !== request.requestId) return
      if (cancelling.value) feedback(false, '本次求解已取消，原排班未改变。')
      else if (inputRevision !== revision) feedback(false, '求解期间设置或排班发生变化，已保留你的修改。请按最新设置重新生成。')
      else {
        const checked = checkDesktopResult(request, result)
        if (checked.success && checked.assignments) {
          remember(); state.value.assignments = checked.assignments; showIssues.value = checked.issues.length > 0
          scheduleSource.value = result.status === 'OPTIMAL' ? '本地 CP-SAT · 最优方案' : '本地 CP-SAT · 可行方案'
        }
        feedback(checked.success, checked.message, checked.success ? [] : checked.issues.map(i => i.message))
      }
    } catch (error) {
      if (!disposed) {
        if (cancelling.value) feedback(false, '本次求解已取消，原排班未改变。')
        else {
          const failure = formatSolverError(error)
          feedback(false, failure.message, [], failure.diagnostic)
          if (failure.diagnostic) { engineState.value = 'error'; engineInfo.value = `本地算法运行检查未通过${failure.code ? `（${failure.code}）` : ''}，需要重新检测。`; engineDiagnostic.value = true }
        }
      }
    } finally { if (!disposed && activeRequestId === request.requestId) finishGeneration() }
    return
  }
  worker = new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = event => {
    const { result, error } = event.data
    if (inputRevision !== revision) feedback(false, '排班期间设置发生变化，已保留你的修改。请按最新设置重新生成。')
    else if (error) feedback(false, error)
    else if (result.success === false || result.issues.some((issue: Issue) => issue.severity === 'error')) { feedback(false, '浏览器搜索未找到满足全部硬性规则的方案，原排班未改变。可调整工时或使用桌面约束求解器重试。', ['以下为未采用方案的问题：', ...result.issues.filter((issue: Issue) => issue.severity === 'error').map((issue: Issue) => issue.message)]) }
    else { remember(); state.value.assignments = result.assignments; showIssues.value = result.issues.length > 0; scheduleSource.value = '浏览器排班 · 启发式方案'; feedback(true, result.issues.length ? `浏览器排班已生成，有 ${result.issues.length} 项需要检查` : '浏览器排班已生成，所有岗位已覆盖，规则检查通过') }
    finishGeneration()
  }
  worker.onerror = () => { feedback(false, '浏览器排班未完成，请检查规则后重试；原排班未改变。'); finishGeneration() }
  workerTimer = window.setTimeout(() => { feedback(false, '浏览器排班已超时，尚未完成搜索，已保留原表。'); finishGeneration() }, 30000)
  worker.postMessage({ state: input, seed })
}
async function cancelGeneration() {
  if (!generating.value || cancelling.value) return
  cancelling.value = true
  if (!desktop) { finishGeneration(); feedback(false, '本次排班已取消，原排班未改变。'); return }
  const requestId = activeRequestId
  if (requestId) {
    try { await cancelDesktop(requestId) }
    catch (error) { if (generating.value) { const failure = formatSolverError(error, 'cancel'); feedback(false, failure.message, [], failure.diagnostic) } }
  }
}
async function download(data: string | Uint8Array, name: string, type: string): Promise<boolean> {
  if (desktop) return exportDesktopFile(data, name)
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data).buffer], { type })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
async function exportExcel() {
  if (payrollError.value) { flash(payrollError.value); return }
  const rows = payrollRows(payroll.value)
  try { if (await download(scheduleXLSX(state.value, { payrollRows: rows }), `${state.value.teamName}-${state.value.month}-排班与津贴.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) flash('Excel 已导出，包含排班、班次和津贴明细') } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function exportBackup() {
  try { if (await download(backupJSON(state.value), `排班 plus-${state.value.month}.json`, 'application/json')) { showBackup.value = false; flash('完整备份已导出') } }
  catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function openImport() {
  if (!desktop) { importer.value?.click(); return }
  try {
    const contents = await importDesktopBackup()
    if (contents !== null) { importCandidate.value = { ...createPayrollConfig(), ...parseBackup(contents) } as Document; showBackup.value = false }
  } catch (e) { flash(e instanceof Error ? e.message : String(e)) }
}
async function selectImport(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return
  try { if (file.size > 2 * 1024 * 1024) throw new Error('备份文件不能超过 2 MB'); importCandidate.value = { ...createPayrollConfig(), ...parseBackup(await file.text()) } as Document }
  catch (e) { flash(e instanceof Error ? e.message : '文件读取失败') }
  input.value = ''; showBackup.value = false
}
function confirmImport() { if (!importCandidate.value) return; state.value = importCandidate.value; importCandidate.value = null; history.value = []; weekIndex.value = 0; saveError.value = ''; scheduleSource.value = '已导入备份排班'; solverFeedback.value = null; flash('备份已导入') }
function jumpToIssue(date?: string) { if (!date) return; if (!date.startsWith(state.value.month)) changeMonth(date.slice(0, 7)); weekIndex.value = weekOf(date); view.value = 'week' }
let noticeTimer = 0
let saveTimer = 0
watch(state, () => { revision++; window.clearTimeout(saveTimer); saveTimer = window.setTimeout(() => {
  if (saveError.value.startsWith('原有数据读取失败')) return
  try { saveLocal(state.value); savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); saveError.value = '' }
  catch { saveError.value = '自动保存失败，请导出 JSON 备份，避免刷新丢失。' }
}, 350) }, { deep: true, flush: 'sync' })
function settingsChanged() { history.value = []; flash('设置已保存，重新生成可按新规则安排班次') }
watch(() => state.value.month, () => { weekIndex.value = 0; history.value = [] }, { flush: 'sync' })
function flushSave() { if (!saveError.value.startsWith('原有数据读取失败')) { try { saveLocal(state.value) } catch { /* The visible save warning covers storage errors. */ } } }
function escapeKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { editing.value = null; calendarDate.value = ''; showGenerate.value = false; showBackup.value = false; showHelp.value = false; importCandidate.value = null; mobileNav.value = false }
  if (event.key === 'Tab') {
    const modal = document.querySelector('.sp-modal')
    const controls = modal ? [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(e => e.offsetParent !== null) : []
    if (controls.length) {
      const first = controls[0]!, last = controls[controls.length - 1]!
      if (event.shiftKey && (document.activeElement === first || !modal?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !modal?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
  }
}
onMounted(() => { if (desktop) void checkEngine(); document.title = '排班 plus · 智能排班'; window.addEventListener('keydown', escapeKey); window.addEventListener('pagehide', flushSave) })
onUnmounted(() => { disposed = true; unlistenProgress?.(); unlistenProgress = null; if (activeRequestId) void cancelDesktop(activeRequestId).catch(() => {}); window.clearInterval(generationTimer); flushSave(); window.removeEventListener('keydown', escapeKey); window.removeEventListener('pagehide', flushSave); worker?.terminate(); window.clearTimeout(workerTimer); window.clearTimeout(saveTimer); window.clearTimeout(noticeTimer) })
watch([editing, calendarDate, showGenerate, showBackup, showHelp, importCandidate], async () => { await nextTick(); (document.querySelector('.sp-modal input, .sp-modal select, .sp-modal button') as HTMLElement | null)?.focus() })
</script>

<template>
  <div class="sp-app">
    <button v-if="mobileNav" class="sp-nav-scrim" aria-label="关闭导航" @click="mobileNav = false"></button>
    <aside class="sp-sidebar" :class="{ 'is-open': mobileNav }">
      <a class="sp-brand" href="#" @click.prevent="chooseSection('calendar')"><img :src="brandMarkUrl" alt="" width="40" height="40" /><span>排班 <b>plus</b></span></a>
      <div class="sp-workspace"><Icon name="people" :size="17" /><strong :title="state.teamName">{{ state.teamName }}</strong></div>
      <nav aria-label="应用导航"><button v-for="item in navigation" :key="item.key" :class="{ active: section === item.key }" :aria-current="section === item.key ? 'page' : undefined" @click="chooseSection(item.key)"><Icon :name="item.icon" /><span>{{ item.label }}</span><span v-if="item.key === 'team'" class="sp-nav-count">{{ state.employees.length }}</span></button></nav>
      <div class="sp-sidebar-bottom"><button class="sp-help" @click="showBackup = true; mobileNav = false"><Icon name="file" :size="18" />备份与恢复</button><button class="sp-help" @click="showHelp = true; mobileNav = false"><Icon name="info" :size="18" />使用帮助</button></div>
    </aside>
    <div class="sp-main">
      <header class="sp-topbar"><div class="sp-breadcrumb"><button class="sp-mobile-toggle sp-icon-button" aria-label="打开导航" @click="mobileNav = true"><Icon name="menu" /></button><span>工作空间</span><Icon name="arrow" :size="13" /><strong>{{ sectionLabel }}</strong></div><div class="sp-top-actions"><span class="sp-save-indicator" :class="{ error: saveError }"><i></i>{{ saveError ? '保存异常' : savedAt ? `${savedAt} 已保存` : '本地保存' }}</span><span class="sp-build-version" title="北京时间 · 本次软件构建时间" :aria-label="`构建版本 ${BUILD_VERSION}`"><span>构建</span><code>{{ BUILD_VERSION }}</code></span></div></header>
      <main class="sp-content">
        <div v-if="saveError" class="sp-banner sp-banner-warning" role="alert"><Icon name="info" /><span>{{ saveError }}</span><button @click="exportBackup">导出备份</button></div>
        <div v-if="dates.some(date => !info(date).verified)" class="sp-banner sp-banner-warning" role="status"><Icon name="calendar" /><span>{{ state.month.slice(0, 4) }} 年的假期安排或法定计薪口径待核对。未手动确认的日期暂按工作日和周末推算，请点击日期核对，或导入已有日历备份。</span></div>
        <div class="sp-page-heading"><div><h1>{{ sectionLabel }}</h1><p v-if="section === 'calendar'" class="sp-context"><span>{{ scheduleSource }}</span><span aria-hidden="true">·</span><button @click="showGenerate = true">{{ desktop ? '本地 CP-SAT' : '浏览器启发式排班' }}</button></p></div><div v-if="section === 'calendar' || section === 'payroll'" class="sp-heading-actions"><button class="sp-button" @click="exportExcel"><Icon name="download" :size="17" />导出 Excel</button><button v-if="section === 'calendar'" class="sp-button sp-primary" :disabled="generating || (desktop && engineState === 'checking')" @click="showGenerate = true"><Icon :name="generating ? 'clock' : 'spark'" :size="18" />{{ generating ? '正在排班…' : desktop && engineState === 'checking' ? '检查算法…' : '自动排班' }}</button></div></div>
        <div v-if="section === 'calendar' && desktop && engineState !== 'ready'" class="sp-engine-strip" :class="{ 'is-error': engineState === 'error' }"><span role="status"><Icon name="info" :size="16" />{{ engineInfo }}</span><button v-if="engineState === 'error'" class="sp-link" @click="showGenerate = true">检测与重试</button></div>
        <div v-if="generating" class="sp-solve-progress" role="status" aria-live="polite"><span class="sp-solve-spinner"></span><div><strong>{{ cancelling ? '正在取消并停止本地任务…' : desktop ? solverPhaseLabels[solvePhase] : '正在生成浏览器排班' }}</strong><p>总计 {{ elapsedSeconds }} 秒<span v-if="desktop"> · 当前阶段 {{ phaseSeconds }} 秒</span> · 完成前保留原表</p><p v-if="desktop">{{ solvePhase === 'solving' ? `排班搜索时限 ${solveTimeLimit} 秒，结束后还需返回并校验结果。` : solvePhase === 'finishing' ? '搜索已结束，正在返回并校验结果。' : `正在准备本地算法，启动和加载不占 ${solveTimeLimit} 秒搜索时限。` }}</p><p v-else>浏览器搜索时限 30 秒。</p></div><button class="sp-button" :disabled="cancelling" @click="cancelGeneration">取消</button></div>
        <div v-if="solverFeedback" class="sp-solve-result" :class="{ 'is-warning': !solverFeedback.success }" role="status"><Icon :name="solverFeedback.success ? 'shield' : 'info'" :size="20" /><div><strong>{{ solverFeedback.message }}</strong><ul v-if="solverFeedback.details.length"><li v-for="(detail,index) in solverFeedback.details.slice(0,8)" :key="index">{{ detail }}</li></ul><p v-if="solverFeedback.details.length > 8">还有 {{ solverFeedback.details.length - 8 }} 项，请检查规则与锁定安排。</p><details v-if="solverFeedback.diagnostic" class="sp-solver-diagnostic"><summary>本地算法诊断</summary><p>若重新检测后仍无法启动，开发者可在项目目录运行 <code>npm run solver:doctor</code>，检查打包的算法组件与本机运行环境。</p></details></div><button class="sp-icon-button" aria-label="关闭求解结果" @click="solverFeedback = null"><Icon name="close" :size="16" /></button></div>
        <dl v-if="section === 'calendar'" class="sp-overview" aria-label="本月排班概览">
          <div><dt>班位覆盖</dt><dd>{{ coverage.percentage }}<small>%</small></dd><span :class="coverage.percentage === 100 ? 'sp-text-green' : 'sp-text-amber'">{{ coverage.percentage === 100 ? `${coverage.filled} 个班位已排满` : `缺 ${coverage.total - coverage.filled} 个班位` }}</span></div>
          <div><dt>参与成员</dt><dd>{{ state.employees.length }}<small>人</small></dd><span>{{ state.shifts.length }} 种班次</span></div>
          <div><dt>计划工时</dt><dd>{{ totalHours.toLocaleString('zh-CN') }}<small>h</small></dd><span>{{ lockedCount }} 项已锁定</span></div>
        </dl>
        <p v-if="payrollError && (section === 'payroll' || section === 'calendar')" class="sp-calculation-error" role="alert">津贴无法计算：{{ payrollError }}。调整配置前不会导出金额。</p>
        <dl v-if="section === 'payroll'" class="sp-overview" aria-label="本月津贴概览">
          <div><dt>本月额外津贴</dt><dd><small>¥</small>{{ payrollError ? '—' : money(payroll.totalAllowance) }}</dd></div>
          <div><dt>领取津贴人数</dt><dd>{{ payrollError ? '—' : allowanceRecipients }}<small>人</small></dd><span>本月已排有津贴的班次</span></div>
          <div><dt>计津贴班次</dt><dd>{{ payrollError ? '—' : allowanceShiftCount }}<small>班</small></dd><span>每人排一次，领取一份</span></div>
        </dl>

        <template v-if="section === 'calendar'">
          <section class="sp-calendar-card" aria-label="人员排班表">
            <div class="sp-calendar-toolbar"><div class="sp-date-controls"><label class="sp-month-label"><Icon name="calendar" :size="19" /><span>{{ monthTitle }}</span><input :value="state.month" type="month" aria-label="选择排班月份" @change="changeMonth(($event.target as HTMLInputElement).value)" /></label><div class="sp-arrows"><button class="sp-icon-button" aria-label="上一时段" @click="navigatePeriod(-1)"><Icon class="sp-flip" name="arrow" :size="16" /></button><button class="sp-icon-button" aria-label="下一时段" @click="navigatePeriod(1)"><Icon name="arrow" :size="16" /></button></div><button class="sp-today" @click="goToday">今天</button><span class="sp-period">{{ period }}</span></div><div class="sp-view-toggle" aria-label="日历视图"><button :class="{ active: view === 'week' }" @click="view = 'week'">周视图</button><button :class="{ active: view === 'month' }" @click="view = 'month'">月视图</button></div></div>
            <div class="sp-filterbar"><div class="sp-filters"><label class="sp-search"><Icon name="search" :size="16" /><input v-model="employeeQuery" placeholder="搜索成员" aria-label="搜索成员" /></label><select v-model="groupFilter" aria-label="按工作组筛选"><option value="">全部工作组</option><option v-for="g in groups" :key="g" :value="g">{{ g }}</option></select></div><div class="sp-legend"><span v-for="s in state.shifts" :key="s.id"><i :style="{ background: s.color }"></i>{{ s.name }}</span><span><i class="sp-leave-dot"></i>请假</span><button class="sp-icon-button" :disabled="!history.length" aria-label="撤销上次调整" @click="undo"><Icon name="undo" :size="16" /></button></div></div>
            <div class="sp-table-scroll" tabindex="0" aria-label="可横向滚动的排班表">
              <table class="sp-schedule-table" :class="{ 'sp-month-table': view === 'month' }">
                <thead><tr>
                  <th class="sp-person-col"><span>团队成员</span><small>{{ employees.length }} 位成员</small></th>
                  <th v-for="date in visibleDates" :key="date" :class="{ 'sp-current-day': date === today, 'sp-restday': info(date).kind === 'restday' }"><button class="sp-date-heading" :aria-label="`设置 ${date} 日期类型`" @click="openDate(date)"><span>周{{ weekday(date) }}</span><strong>{{ Number(date.slice(8)) }}<i v-if="date === today"></i></strong><small v-if="info(date).kind === 'statutory'" class="sp-holiday">{{ info(date).label }}</small><small v-else-if="info(date).label.includes('调休') || info(date).label.includes('补班')">{{ info(date).label }}</small><small v-else>{{ date === today ? '今天' : ' ' }}</small></button></th>
                  <th class="sp-hours-col" title="仅计算实际落在本月的工时，包括上月夜班进入本月的部分">本月工时</th>
                  <th class="sp-allowance-col" title="按本月开始的班次数累计固定津贴">额外津贴<small>当月合计 · 元</small></th>
                </tr></thead>
                <tbody>
                  <tr v-for="employee in employees" :key="employee.id">
                    <th class="sp-person-col"><div class="sp-person"><span class="sp-person-avatar" :style="{ background: employee.color }">{{ employee.name.slice(-2) }}</span><span><strong>{{ employee.name }}</strong><small>{{ employee.role }} · {{ employee.group }}</small></span></div></th>
                    <td v-for="date in visibleDates" :key="date" :class="{ 'sp-current-day': date === today }">
                      <button class="sp-shift-cell" :class="{ 'is-off': !findShift(entry(employee.id,date)?.shiftId || '') && !leave(employee,date), 'is-leave': leave(employee,date), 'has-allowance': (dayAllowance(employee.id,date)?.totalAllowance ?? 0) > 0 }" :style="findShift(entry(employee.id,date)?.shiftId || '') && !leave(employee,date) ? { background: findShift(entry(employee.id,date)!.shiftId)!.color } : {}" :aria-label="`${employee.name} ${date} ${leave(employee,date) ? '请假' : findShift(entry(employee.id,date)?.shiftId || '')?.name || '休息'}，点击编辑`" :aria-description="allowanceDescription(employee.id,date)" :title="allowanceDescription(employee.id,date)" @click="openCell(employee,date)">
                        <template v-if="leave(employee,date)"><span>请假</span><small>全天休假</small></template>
                        <template v-else-if="findShift(entry(employee.id,date)?.shiftId || '')"><span>{{ findShift(entry(employee.id,date)!.shiftId)!.name }}<Icon v-if="entry(employee.id,date)?.locked" name="lock" :size="10" /></span><small>{{ findShift(entry(employee.id,date)!.shiftId)!.start }}–{{ findShift(entry(employee.id,date)!.shiftId)!.end }}</small></template>
                        <template v-else-if="dayAllowance(employee.id,date)?.carriedShiftIds.length"><span>跨夜续班</span><small>来自前一天排班</small></template>
                        <template v-else><span>休息 <Icon v-if="entry(employee.id,date)?.locked" name="lock" :size="10" /></span><small class="sp-off-add">＋ 调整班次</small></template>
                        <span v-if="(dayAllowance(employee.id,date)?.totalAllowance ?? 0) > 0" class="sp-allowance-badge" :data-allowance="dayAllowance(employee.id,date)!.totalAllowance" :data-allowance-date="date" :data-allowance-employee="employee.id">＋¥{{ money(dayAllowance(employee.id,date)!.totalAllowance) }}</span>
                      </button>
                    </td>
                    <td class="sp-hours-col"><strong>{{ employeeHours(employee.id) }}<small> h</small></strong><span>{{ employeeDays(employee.id) }} 个班次</span><span>最低 {{ minimumMonthHours(state, employee) }} h</span></td>
                    <td class="sp-allowance-col" :data-employee-allowance="employee.id" :data-allowance="payrollError ? null : employeeAllowances.get(employee.id)?.totalAllowance ?? 0"><strong v-if="payrollError">无法计算</strong><template v-else><strong>¥{{ money(employeeAllowances.get(employee.id)?.totalAllowance ?? 0) }}</strong><span>按班次固定金额累计</span></template></td>
                  </tr>
                  <tr v-if="!employees.length"><td :colspan="visibleDates.length+3" class="sp-empty">没有找到成员，请修改筛选条件或添加成员。</td></tr>
                </tbody>
                <tfoot>
                  <tr><th class="sp-person-col">每日覆盖 <small>已安排 / {{ state.rules.weekdayWeights ? '配额范围' : '需求' }}</small></th><td v-for="date in visibleDates" :key="date"><span :class="dailyCovered(date) ? 'sp-text-green' : 'sp-text-amber'">{{ dailyFilled(date) }} <small>/ {{ dailyDemandLabel(date) }}</small></span></td><td class="sp-hours-col">{{ totalHours }} h</td><td class="sp-allowance-col">—</td></tr>
                  <tr class="sp-allowance-footer"><th class="sp-person-col">津贴合计<small>当前筛选成员</small></th><td v-for="date in visibleDates" :key="date">¥{{ payrollError ? '—' : money(dailyAllowanceTotal(date)) }}</td><td class="sp-hours-col">当月汇总 →</td><td class="sp-allowance-col" :data-allowance-total="payrollError ? null : filteredAllowanceTotal"><strong>¥{{ payrollError ? '—' : money(filteredAllowanceTotal) }}</strong></td></tr>
                </tfoot>
              </table>
            </div>
            <p class="sp-allowance-legend"><span aria-hidden="true">✦</span> 金色金额为该班次的固定津贴，排一次领取一份。跨夜班全部津贴记在开始日期，只领一次。右侧汇总整月金额。</p>
            <div class="sp-calendar-bottom"><span><Icon name="lock" :size="14" />点击班次调整，锁定后自动排班保留</span><button class="sp-check-status" :class="{ warning: issues.length }" :aria-expanded="showIssues" @click="showIssues = !showIssues"><Icon :name="issues.length ? 'info' : 'shield'" :size="15" />{{ issues.length ? `${issues.length} 项排班提醒` : '排班检查通过' }}<Icon name="arrow" :size="13" /></button></div>
          </section>
          <div v-if="showIssues" class="sp-issues"><template v-if="issues.length"><button v-for="issue in issues.slice(0, 100)" :key="issue.id" @click="jumpToIssue(issue.date)"><span :class="issue.severity">{{ issue.severity === 'error' ? '冲突' : '提醒' }}</span><span>{{ issue.message }}</span><small v-if="issue.date">{{ issue.date }} ↗</small></button><p v-if="issues.length > 100">还有 {{ issues.length - 100 }} 项，请先处理当前提醒。</p></template><p v-else>休假、班次资格、月最低与周工时上下限、连续工作和休息间隔均通过检查。<button class="sp-link" @click="chooseSection('rules')">自定义规则 →</button></p></div>
        </template>

        <SettingsPanel v-if="section !== 'calendar'" :state="state" :section="section" :payroll="state.payroll" :calendar="state.calendar" @change="settingsChanged" />
        <section v-if="section === 'payroll'" class="sp-payroll-card">
          <div class="sp-subheading"><div><h2>{{ monthTitle }} · 成员津贴汇总</h2><p>按本月开始的班次数累计固定津贴，跨夜班只在开始日期领取一次。</p></div></div>
          <div v-if="!payrollError" class="sp-table-scroll"><table class="sp-payroll-table"><thead><tr><th>团队成员</th><th>本月工时</th><th>额外津贴</th></tr></thead><tbody><tr v-for="row in payroll.rows" :key="row.employeeId"><th>{{ row.name }}</th><td>{{ row.totalHours }} h</td><td class="sp-text-gold"><strong>¥{{ money(row.totalAllowance) }}</strong></td></tr><tr v-if="!payroll.rows.length"><td colspan="3">暂无成员，请先添加成员并安排班次。</td></tr></tbody><tfoot><tr><th>合计</th><td>{{ totalHours }} h</td><td><strong>¥{{ money(payroll.totalAllowance) }}</strong></td></tr></tfoot></table></div>
          <div v-if="payroll.warnings.length" class="sp-payroll-note"><Icon name="info" :size="17" /><span>{{ payroll.warnings.join('；') }}</span></div>
        </section>
      </main>
    </div>

    <input v-if="!desktop" ref="importer" class="sp-hidden" type="file" accept=".json,application/json" @change="selectImport" />
    <div v-if="notice" class="sp-toast" role="status"><Icon name="info" :size="18" />{{ notice }}<button aria-label="关闭提示" @click="notice = ''"><Icon name="close" :size="15" /></button></div>

    <div v-if="editing" class="sp-overlay" @click.self="editing = null"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-edit-title"><div class="sp-modal-heading"><div><h2 id="sp-edit-title">调整班次</h2><p>{{ editing.employee.name }} · {{ editing.date }} · 周{{ weekday(editing.date) }}</p></div><button class="sp-icon-button" aria-label="关闭班次编辑" @click="editing = null"><Icon name="close" /></button></div><div class="sp-shift-options"><button v-for="s in state.shifts" :key="s.id" :disabled="!editing.employee.eligibleShiftIds.includes(s.id)" :class="{ selected: editing.shiftId === s.id }" @click="editing.shiftId = s.id"><span class="sp-shift-swatch" :style="{ background: s.color }">{{ s.shortName }}</span><span><strong>{{ s.name }}</strong><small>{{ s.start }}–{{ s.end }} · {{ shiftHours(s) }} 小时{{ editing.employee.eligibleShiftIds.includes(s.id) ? '' : ' · 未获得该班资格' }}</small></span><Icon v-if="editing.shiftId === s.id" name="check" /></button><button :class="{ selected: editing.shiftId === 'off' }" @click="editing.shiftId = 'off'"><span class="sp-shift-swatch">休</span><span><strong>安排休息</strong><small>锁定后，自动排班不会占用这一天</small></span></button><button :class="{ selected: editing.shiftId === 'leave' }" @click="editing.shiftId = 'leave'"><span class="sp-shift-swatch sp-leave-swatch">假</span><span><strong>全天请假</strong><small>作为不可排班日期保存</small></span></button></div><div class="sp-edit-allowance" role="note"><strong>已保存排班的当日津贴</strong><p>{{ allowanceDescription(editing.employee.id, editing.date) }}</p><small>保存班次调整后会重新计算。</small></div><label v-if="editing.shiftId !== 'leave'" class="sp-lock-toggle"><input v-model="editing.locked" type="checkbox" /><Icon name="lock" :size="15" /><span>锁定本次安排，重新排班时保留</span></label><div class="sp-modal-actions"><button class="sp-button" @click="editing = null">取消</button><button class="sp-button sp-primary" @click="saveCell">保存安排</button></div></section></div>

    <div v-if="calendarDate" class="sp-overlay" @click.self="calendarDate = ''"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-date-title"><div class="sp-modal-heading"><div><h2 id="sp-date-title">{{ calendarDate }} · 日期类型</h2><p>该设置用于日历与自动月参考工时；日期类型不会改变固定津贴。</p></div><button class="sp-icon-button" aria-label="关闭日期设置" @click="calendarDate = ''"><Icon name="close" /></button></div><div class="sp-shift-options"><button v-for="option in [{kind:'workday',label:'正常工作日 / 调休补班',note:'计入月参考工时的工作日天数'},{kind:'restday',label:'休息日',note:'不计入月参考工时的工作日天数'},{kind:'statutory',label:'法定节假日',note:'仅标记日期类型，不自动增加津贴'}]" :key="option.kind" :class="{ selected: calendarKind === option.kind }" @click="calendarKind = option.kind as DayKind"><span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span><Icon v-if="calendarKind === option.kind" name="check" /></button></div><p class="sp-modal-note">{{ info(calendarDate).verified ? '当前日期已采用库内日历或人工确认。' : '该日期待核对，请核对工作日安排后设置。' }}{{ info(calendarDate).source }}</p><div class="sp-modal-actions"><button class="sp-button" @click="saveCalendar(true)">恢复默认</button><button class="sp-button sp-primary" @click="saveCalendar()">确认日期类型</button></div></section></div>

    <div v-if="showGenerate" class="sp-overlay" @click.self="showGenerate = false"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-generate-title"><div class="sp-modal-heading"><div><h2 id="sp-generate-title">为 {{ monthTitle }} 生成排班</h2></div><button class="sp-icon-button" aria-label="关闭自动排班" @click="showGenerate = false"><Icon name="close" /></button></div><div class="sp-generation-summary"><Icon name="spark" :size="35" /><div><strong>{{ state.employees.length }} 位成员 · {{ state.shifts.length }} 个班次</strong><p>需要安排 {{ coverage.total }} 个班位，保留 {{ lockedCount }} 个已锁定安排。</p></div></div><p class="sp-modal-copy">将重新安排本月未锁定的班次，综合考虑请假、班次资格、月最低工时、周工时上下限、休息间隔、指定人员同班互斥、上班权重与轮班公平性。</p><template v-if="desktop"><div class="sp-solver-options"><div class="sp-solver-engine" :class="{ 'is-error': engineState === 'error' }"><Icon :name="engineState === 'ready' ? 'shield' : 'info'" :size="18" /><span><strong>本地 OR-Tools CP-SAT</strong><small role="status">{{ engineInfo }}</small></span><button v-if="engineState === 'error'" class="sp-button" @click="checkEngine">重试检测</button></div><p v-if="engineState === 'checking'" class="sp-engine-explanation">启动检测完成后即可开始排班，避免检测与计算同时占用本地算法。</p><details v-if="engineDiagnostic" class="sp-solver-diagnostic"><summary>本地算法诊断</summary><p>开发者可在项目目录运行 <code>npm run solver:doctor</code>，检查算法组件与运行环境。</p></details><label>最长搜索时间<select v-model.number="solveTimeLimit" aria-label="最长搜索时间"><option v-for="seconds in [5,15,30,60]" :key="seconds" :value="seconds">{{ seconds }} 秒</option></select></label><label class="sp-partial-option"><input v-model="allowPartial" type="checkbox" /><span>允许岗位缺编<small>仍遵守全部硬规则；启用上班权重时，各周配额必须排满，不能用缺编放宽。</small></span></label></div><p class="sp-modal-copy">{{ allowPartial ? '尽量安排人员，允许部分班位留空；只接受通过硬性规则检查的方案。' : '所有班位必须排满。如果规则冲突或时间内未找到方案，不会改动原排班。' }}</p></template><p v-else class="sp-modal-note">当前为浏览器启发式排班，无法保证找到最优方案。未启用上班权重时允许岗位缺口；启用后配额必须满足。桌面版可使用本地约束求解器。</p><p class="sp-modal-note">其他月份保持原样。本次生成后，可使用表格右上角的撤销按钮恢复。</p><div class="sp-modal-actions"><button class="sp-button" @click="showGenerate = false">再看看</button><button class="sp-button sp-primary" :disabled="desktop && engineState !== 'ready'" @click="generate"><Icon name="spark" :size="17" />{{ desktop && engineState === 'checking' ? '等待启动检测' : '开始生成' }}</button></div></section></div>

    <div v-if="showBackup" class="sp-overlay" @click.self="showBackup = false"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-backup-title"><div class="sp-modal-heading"><div><h2 id="sp-backup-title">备份与恢复</h2><p>数据保存在{{ storageLocation }}，不会自动云同步。</p></div><button class="sp-icon-button" aria-label="关闭备份面板" @click="showBackup = false"><Icon name="close" /></button></div><div class="sp-shift-options"><button @click="exportBackup"><Icon name="download" /><span><strong>导出完整备份</strong><small>JSON 文件，可在另一台设备恢复</small></span><Icon name="arrow" :size="16" /></button><button @click="openImport"><Icon name="upload" /><span><strong>导入备份文件</strong><small>确认后替换当前工作空间，建议先导出备份</small></span><Icon name="arrow" :size="16" /></button></div></section></div>

    <div v-if="importCandidate" class="sp-overlay"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-import-title"><h2 id="sp-import-title">确认恢复这个工作空间？</h2><p class="sp-modal-copy">{{ importCandidate.teamName }} · {{ importCandidate.month }}<br />{{ importCandidate.employees.length }} 位成员、{{ importCandidate.shifts.length }} 种班次。导入将替换当前数据。</p><div class="sp-modal-actions"><button class="sp-button" @click="importCandidate = null">取消</button><button class="sp-button sp-primary" @click="confirmImport">确认导入</button></div></section></div>

    <div v-if="showHelp" class="sp-overlay" @click.self="showHelp = false"><section class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-help-title"><div class="sp-modal-heading"><h2 id="sp-help-title">几步，安排好下个月</h2><button class="sp-icon-button" aria-label="关闭帮助" @click="showHelp = false"><Icon name="close" /></button></div><ol class="sp-help-list"><li><strong>添加团队成员</strong><p>月参考工时默认按工作日 × 8 计算；设置每人的月最低工时、周最低/最高工时、班次资格和请假日期。</p></li><li><strong>定义班次和规则</strong><p>自定义上下班时间、每日需求人数、休息间隔与连续工作天数。</p></li><li><strong>选择月份，自动生成</strong><p>点击格子调整或锁定安排。规则冲突会显示在表格下方。</p></li><li><strong>设置班次津贴</strong><p>为班次填写每人每班的固定津贴。排一次领取一份，跨夜只计一次；排班表金色金额与右侧月汇总实时更新。</p></li><li><strong>导出 Excel 和备份</strong><p>Excel 用于查看分享，JSON 用于恢复全部设置。首次进入展示的是可编辑示例团队。</p></li></ol></section></div>
  </div>
</template>
