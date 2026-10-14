<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Employee, PlannerState, Rules, Shift } from './domain.ts'
import type { PayrollSettings } from './payroll.ts'
import LeaveCalendarDialog from './LeaveCalendarDialog.vue'
import EmployeeDialog from './EmployeeDialog.vue'
import ShiftDialog from './ShiftDialog.vue'
import EmployeeAvatar from './EmployeeAvatar.vue'
import { isAvatarData } from './avatarData.ts'
import ShiftRulesPanel from './ShiftRulesPanel.vue'
import { hoursToMinutes, monthlyHoursReference } from './hours.ts'
import { weightedDayRange, weightedWeeks, weekdayWeightCapacity, weekdayWeightRuleError } from './weekday-weights.ts'
import type { WeightedWeek } from './weekday-weights.ts'

const props = defineProps<{ state: PlannerState; section: 'team' | 'shifts' | 'rules'; payroll: PayrollSettings }>()
const emit = defineEmits<{ change: [options?: { silent?: boolean }] }>()
// Keep these form limits aligned with storage.ts so every saved form can be backed up.
const limits = { employees: 200, shifts: 24, separationGroups: 200, monthlyReferences: 1200, leaveDates: 3660, employeeText: 80, shiftName: 60, shortName: 8, groupName: 80, required: 200, minRestHours: 48, allowance: 100000000 }
const feedback = ref('')
const error = ref('')
const editor = ref<'employee' | 'shift' | 'separation' | null>(null)
const editorElement = ref<HTMLFormElement | null>(null)
let editorTrigger: HTMLElement | null = null
const pendingDelete = ref<{ type: 'employee' | 'shift' | 'separation'; id: string; name: string } | null>(null)
const leaveEmployeeId = ref('')
const leaveEmployee = computed(() => props.state.employees.find(employee => employee.id === leaveEmployeeId.value))
const employeeDraft = reactive<Employee>({ id: '', name: '', role: '', group: '', color: '#d7e8f8', avatar: null, minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: [], unavailableDates: [] })
const monthReference = computed(() => monthlyHoursReference(props.state))
const referenceDraft = ref<number | string>(monthReference.value.hours)
const referenceError = ref('')
const referenceSaved = ref(false)
let referenceEdited = false
type HoursGroup = 'month' | 'week' | 'eligibility'
type HoursDraft = { followReference: boolean; month: number | string; weekMin: number | string; weekMax: number | string; eligibleShiftIds: string[]; sources: Record<HoursGroup, string>; errors: Record<HoursGroup, string>; saved: boolean }
type HoursTask = { timer: ReturnType<typeof setTimeout>; state: PlannerState; month: string; employeeId: string; group: HoursGroup; draft: HoursDraft }
type ReferenceTask = { timer: ReturnType<typeof setTimeout>; state: PlannerState; month: string; value: number }
const hoursDrafts = reactive<Record<string, HoursDraft>>(Object.create(null))
const hoursTasks = new Map<string, HoursTask>()
let referenceTask: ReferenceTask | null = null
let disposed = false
const autosaveDelay = 500
const hoursGroups: HoursGroup[] = ['month', 'week', 'eligibility']
function sourceFor(employee: Employee, group: HoursGroup) {
  return JSON.stringify(group === 'month' ? employee.minHoursPerMonth ?? null : group === 'week' ? [employee.minHoursPerWeek ?? 0, employee.maxHoursPerWeek] : [...employee.eligibleShiftIds].sort())
}
function cancelHoursTask(id: string, group: HoursGroup) {
  const key = `${id}:${group}`, task = hoursTasks.get(key)
  if (task) clearTimeout(task.timer)
  hoursTasks.delete(key)
}
function cancelHoursTasks() { for (const task of hoursTasks.values()) clearTimeout(task.timer); hoursTasks.clear() }
function cancelReferenceTask() { if (referenceTask) clearTimeout(referenceTask.timer); referenceTask = null }
function resetHoursGroup(employee: Employee, group: HoursGroup) {
  const draft = hoursDrafts[employee.id]!
  cancelHoursTask(employee.id, group)
  if (group === 'month') { draft.followReference = employee.minHoursPerMonth == null; draft.month = employee.minHoursPerMonth ?? monthReference.value.hours }
  else if (group === 'week') { draft.weekMin = employee.minHoursPerWeek ?? 0; draft.weekMax = employee.maxHoursPerWeek }
  else draft.eligibleShiftIds = [...employee.eligibleShiftIds]
  draft.sources[group] = sourceFor(employee, group); draft.errors[group] = ''
}
function resetEmployeeHours(employee: Employee) {
  hoursDrafts[employee.id] = { followReference: true, month: 0, weekMin: 0, weekMax: 0, eligibleShiftIds: [], sources: { month: '', week: '', eligibility: '' }, errors: { month: '', week: '', eligibility: '' }, saved: false }
  for (const group of hoursGroups) resetHoursGroup(employee, group)
}
watch(() => props.state.employees.map(employee => [employee.id, ...hoursGroups.map(group => sourceFor(employee, group))]), () => {
  const employeeIds = new Set(props.state.employees.map(employee => employee.id))
  for (const id of Object.keys(hoursDrafts)) if (!employeeIds.has(id)) {
    for (const group of hoursGroups) cancelHoursTask(id, group)
    delete hoursDrafts[id]
  }
  for (const employee of props.state.employees) {
    if (!Object.hasOwn(hoursDrafts, employee.id)) resetEmployeeHours(employee)
    else for (const group of hoursGroups) if (hoursDrafts[employee.id]!.sources[group] !== sourceFor(employee, group)) resetHoursGroup(employee, group)
  }
}, { immediate: true, flush: 'sync' })
watch(() => props.state, () => {
  // Importing a different document cancels all old writes, including matching IDs.
  cancelHoursTasks(); cancelReferenceTask()
  for (const id of Object.keys(hoursDrafts)) delete hoursDrafts[id]
  for (const employee of props.state.employees) resetEmployeeHours(employee)
  referenceDraft.value = monthReference.value.hours; referenceError.value = ''; referenceSaved.value = false; referenceEdited = false
}, { flush: 'sync' })
function equalHours(value: number | string, reference: number) { return String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) === reference }
function groupDirty(employee: Employee, group: HoursGroup) {
  const draft = hoursDrafts[employee.id]!
  if (group === 'month') return draft.followReference !== (employee.minHoursPerMonth == null) || (!draft.followReference && !equalHours(draft.month, employee.minHoursPerMonth ?? monthReference.value.hours))
  if (group === 'week') return !equalHours(draft.weekMin, employee.minHoursPerWeek ?? 0) || !equalHours(draft.weekMax, employee.maxHoursPerWeek)
  return JSON.stringify([...draft.eligibleShiftIds].sort()) !== JSON.stringify([...employee.eligibleShiftIds].sort())
}
function hoursDirty(employee: Employee) { return hoursGroups.some(group => groupDirty(employee, group)) }
function hoursErrors(employee: Employee) { return Object.values(hoursDrafts[employee.id]!.errors).filter(Boolean) }
function validateHoursGroup(employee: Employee, group: HoursGroup) {
  const draft = hoursDrafts[employee.id]!
  draft.errors[group] = ''
  if (!groupDirty(employee, group)) return true
  if (group === 'eligibility') return true
  const fields: [number | string, number, string][] = group === 'week' ? [[draft.weekMin, 168, '每周最低工时'], [draft.weekMax, 168, '每周最高工时']] : draft.followReference ? [] : [[draft.month, 744, '每月最低工时']]
  for (const [value, max, label] of fields) {
    if (String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max) { draft.errors[group] = `${label}需为 0–${max} 小时的有效数值，当前修改未保存。`; return false }
  }
  if (group === 'week' && hoursToMinutes(Number(draft.weekMax), 'floor') - hoursToMinutes(Number(draft.weekMin), 'ceil') < 480) {
    draft.errors.week = '每周最高与最低工时至少相差 8 小时（最低向上、最高向下取整到分钟）；当前修改未保存。'; return false
  }
  return true
}
function commitHoursGroup(id: string, group: HoursGroup, expectedState = props.state, expectedMonth = props.state.month, expectedDraft = hoursDrafts[id], monthTransition = false) {
  cancelHoursTask(id, group)
  if (disposed || props.state !== expectedState || (!monthTransition && props.state.month !== expectedMonth) || hoursDrafts[id] !== expectedDraft) return
  const current = props.state.employees.find(employee => employee.id === id), draft = hoursDrafts[id]
  if (!current || !draft || !validateHoursGroup(current, group) || !groupDirty(current, group)) return
  // Only this field group is merged; another group's unfinished input is preserved.
  const patch = group === 'month' ? { minHoursPerMonth: draft.followReference ? null : Number(draft.month) } : group === 'week' ? { minHoursPerWeek: Number(draft.weekMin), maxHoursPerWeek: Number(draft.weekMax) } : { eligibleShiftIds: [...new Set(draft.eligibleShiftIds)].filter(shiftId => props.state.shifts.some(shift => shift.id === shiftId)) }
  props.state.employees.splice(props.state.employees.indexOf(current), 1, { ...current, ...patch })
  hoursDrafts[id]!.saved = true
  emit('change', { silent: true })
}
function scheduleHours(employee: Employee, group: HoursGroup, immediate = false) {
  cancelHoursTask(employee.id, group)
  const current = props.state.employees.find(item => item.id === employee.id)
  if (!current || !validateHoursGroup(current, group) || !groupDirty(current, group)) return
  if (immediate) { commitHoursGroup(employee.id, group); return }
  const task: HoursTask = { timer: 0 as unknown as ReturnType<typeof setTimeout>, state: props.state, month: props.state.month, employeeId: employee.id, group, draft: hoursDrafts[employee.id]! }
  task.timer = setTimeout(() => commitHoursGroup(task.employeeId, task.group, task.state, task.month, task.draft), autosaveDelay)
  hoursTasks.set(`${employee.id}:${group}`, task)
}
function inputHours(employee: Employee, field: 'month' | 'weekMin' | 'weekMax', event: Event) {
  hoursDrafts[employee.id]![field] = (event.target as HTMLInputElement).value
  scheduleHours(employee, field === 'month' ? 'month' : 'week')
}
function toggleEmployeeShift(employee: Employee, shiftId: string) {
  const draft = hoursDrafts[employee.id]!
  draft.eligibleShiftIds = draft.eligibleShiftIds.includes(shiftId) ? draft.eligibleShiftIds.filter(id => id !== shiftId) : [...draft.eligibleShiftIds, shiftId]
  scheduleHours(employee, 'eligibility', true)
}
function setHoursFollow(employee: Employee, event: Event) {
  const draft = hoursDrafts[employee.id]!, checked = (event.target as HTMLInputElement).checked
  if (draft.followReference && !checked) draft.month = monthReference.value.hours
  draft.followReference = checked
  scheduleHours(employee, 'month', true)
}
function saveEmployeeHours(employee: Employee) { for (const group of hoursGroups) commitHoursGroup(employee.id, group) }
function flushHoursTasks(transitionFrom?: string) {
  for (const task of [...hoursTasks.values()]) commitHoursGroup(task.employeeId, task.group, task.state, task.month, task.draft, transitionFrom !== undefined && task.month === transitionFrom)
  cancelHoursTasks()
}
function flushMemberAutosave() { flushHoursTasks(); flushReferenceTask() }
watch(() => props.section, (section, previous) => { if (previous === 'team' && section !== 'team') flushMemberAutosave() }, { flush: 'sync' })
watch([() => props.state.month, () => monthReference.value.hours, () => monthReference.value.custom], ([month], previous) => {
  if (previous && month !== previous[0]) {
    // Commit valid edits against their original document and draft, before
    // resetting month-dependent displays. Delayed callbacks retain strict guards.
    flushReferenceTask(); flushHoursTasks(previous[0])
    for (const employee of props.state.employees) resetEmployeeHours(employee)
    referenceSaved.value = false
    referenceEdited = false
  }
  referenceDraft.value = monthReference.value.hours; referenceError.value = ''
}, { flush: 'sync' })
onMounted(() => window.addEventListener('pagehide', flushMemberAutosave, true))
onBeforeUnmount(() => {
  flushMemberAutosave(); disposed = true
  cancelHoursTasks(); cancelReferenceTask()
  window.removeEventListener('pagehide', flushMemberAutosave, true)
})
function openLeave(employee: Employee) { leaveEmployeeId.value = employee.id; error.value = ''; feedback.value = '' }
function saveLeave(dates: string[]) {
  const employee = leaveEmployee.value
  if (!employee) { leaveEmployeeId.value = ''; return }
  if (dates.length > limits.leaveDates || dates.some(date => !validDate(date))) { error.value = `请假日期需为有效日期，最多 ${limits.leaveDates} 天。`; return }
  employee.unavailableDates = [...new Set(dates)].sort()
  leaveEmployeeId.value = ''
  notice(`${employee.name}的请假已保存；已有排班（含锁定安排）保持不变，请检查请假冲突。`)
}
const shiftDraft = reactive<Shift>({ id: '', name: '', shortName: '', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, staffingMode: 'minimum', normalAllowance: 0 })
const shiftStaffingLabel = computed(() => shiftDraft.staffingMode === 'fixed' ? '每日固定人数' : '每日最少人数')
const rulesDraft = reactive<Rules>({ ...props.state.rules })
const ruleCategory = ref<'personal' | 'team'>('personal')
function selectRuleCategory(category: 'personal' | 'team', moveFocus = false) {
  ruleCategory.value = category
  if (moveFocus) void nextTick(() => document.getElementById(`sp-rule-tab-${category}`)?.focus())
}
const weekdayOptions = [
  { value: 1, label: '星期一', short: '周一' }, { value: 2, label: '星期二', short: '周二' },
  { value: 3, label: '星期三', short: '周三' }, { value: 4, label: '星期四', short: '周四' },
  { value: 5, label: '星期五', short: '周五' }, { value: 6, label: '星期六', short: '周六' },
  { value: 7, label: '星期日', short: '周日' },
]
const weekdayWeightsEnabled = ref(!!props.state.rules.weekdayWeights)
const weekdayDays = ref<number[]>([...(props.state.rules.weekdayWeights?.days ?? [1, 6])])
const weekdayPercent = ref<number | string>(props.state.rules.weekdayWeights?.percent ?? 40)
const weekdayDraftError = computed(() => weekdayWeightsEnabled.value ? weekdayWeightRuleError({ days: weekdayDays.value, percent: weekdayPercent.value }) : null)
const weekdayPreviewState = computed<PlannerState>(() => ({
  ...props.state,
  rules: { ...rulesDraft, weekdayWeights: weekdayWeightsEnabled.value && !weekdayDraftError.value ? { days: [...weekdayDays.value].sort((a, b) => a - b), percent: Number(weekdayPercent.value) } : undefined },
}))
const weekdayExampleTotal = ref<number | string>(props.state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7)
const weekdayExampleError = computed(() => String(weekdayExampleTotal.value).trim() === '' || !Number.isInteger(Number(weekdayExampleTotal.value)) || Number(weekdayExampleTotal.value) < 0 || Number(weekdayExampleTotal.value) > 1000000 ? '演示总班数需为 0–1000000 的整数。' : '')
const weekdayPreviewWeeks = computed(() => weekdayExampleError.value ? [] : weightedWeeks(weekdayPreviewState.value, Number(weekdayExampleTotal.value)))
const weekdayCapacity = computed(() => weekdayWeightCapacity(weekdayPreviewState.value))
const weekdayMinimum = computed(() => props.state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7)
const weekdayMaximum = computed(() => props.state.shifts.some(shift => shift.staffingMode !== 'fixed') ? props.state.employees.length * 7 : Math.min(props.state.employees.length * 7, weekdayMinimum.value))
const weekdayExampleBelowMinimum = computed(() => weekdayPreviewWeeks.value.some(week => week.dates.some(date => weightedDayRange(week, date)[0] < weekdayMinimum.value / 7)))
const weekdayFullSelected = computed(() => Math.ceil(Number(weekdayExampleTotal.value) * Number(weekdayPercent.value) / 100))
const weekdaySelectedLabel = computed(() => weekdayOptions.filter(day => weekdayDays.value.includes(day.value)).map(day => day.short).join('、'))
const weekdayMonthlyTotal = computed(() => weekdayPreviewWeeks.value.reduce((sum, week) => sum + week.totalTarget, 0))
function resetRules() {
  Object.assign(rulesDraft, props.state.rules)
  weekdayWeightsEnabled.value = !!props.state.rules.weekdayWeights
  weekdayDays.value = [...(props.state.rules.weekdayWeights?.days ?? [1, 6])]
  weekdayPercent.value = props.state.rules.weekdayWeights?.percent ?? 40
  weekdayExampleTotal.value = props.state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7
}
function dayWeightLabel(date: string) { return weekdayOptions[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!.short }
function dayWeightRange(week: WeightedWeek, date: string) {
  const [low, high] = weightedDayRange(week, date)
  return low === high ? `${low}` : `${low}–${high}`
}
type SeparationGroup = NonNullable<Rules['separationGroups']>[number]
const separationDraft = reactive<SeparationGroup>({ id: '', name: '', employeeIds: [], shiftIds: [] })
const separationAllShifts = ref(true)
const separationGroups = computed(() => props.state.rules.separationGroups ?? [])
const employeeSearch = ref('')
async function focusDiagnostic(employeeId?: string, shiftId?: string, ruleType?: string) {
  employeeSearch.value = ''
  if (props.section === 'rules') ruleCategory.value = ruleType?.startsWith('weekday-') || ruleType === 'separation' || ruleType?.startsWith('separation-') ? 'team' : 'personal'
  await nextTick()
  const id = props.section === 'team' && employeeId ? `member-${employeeId}` : props.section === 'shifts' && shiftId ? `shift-${shiftId}` : props.section === 'rules' ? `sp-rule-panel-${ruleCategory.value}` : ''
  const element = (id ? document.getElementById(id) : null) ?? document.querySelector<HTMLElement>('.sp-settings')
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  element?.focus({ preventScroll: true })
}
// The parent must flush drafts before its synchronous pagehide persistence;
// window-level pagehide listeners cannot safely rely on registration order.
defineExpose({ focusDiagnostic, flushAutosave: flushMemberAutosave })
const displayedEmployees = computed(() => props.state.employees.filter(employee => `${employee.name} ${employee.role} ${employee.group}`.includes(employeeSearch.value.trim())))
const sortedShifts = computed(() => props.state.shifts.map((shift, index) => ({ shift, index })).sort((a, b) => a.shift.start.localeCompare(b.shift.start) || a.index - b.index).map(item => item.shift))
const colors = ['#dbeee6', '#e5def7', '#dce8fa', '#f8e5cc', '#f7dbdf', '#dceced', '#ebe6df']
const shiftDuration = computed(() => {
  const parse = (time: string) => { const [h = 0, m = 0] = time.split(':').map(Number); return h * 60 + m }
  const minutes = (parse(shiftDraft.end) - parse(shiftDraft.start) + 1440) % 1440
  return Number((minutes / 60).toFixed(2))
})
watch([() => props.section, () => props.state], () => {
  editor.value = null; editorTrigger = null; leaveEmployeeId.value = ''; pendingDelete.value = null; feedback.value = ''; error.value = ''
  resetRules()
})
function notice(message: string) { feedback.value = message; error.value = ''; emit('change') }
function validText(value: string, max: number, label: string, allowEmpty = false) {
  if ((!allowEmpty && !value.trim()) || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    error.value = `${label}${allowEmpty ? '最多' : '需要填写，最多'} ${max} 个字符，且不能含控制字符。`; return false
  }
  return true
}
function validDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) && Number(value.slice(0, 4)) >= 1 && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}
function validHours(value: unknown, max: number, label: string) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max) {
    error.value = `${label}需要填写 0–${max} 小时之间的有效数值。`; return false
  }
  return true
}
function flushReferenceTask() {
  const task = referenceTask
  cancelReferenceTask()
  if (!task || disposed || props.state !== task.state) return
  const overrides = props.state.monthlyReferenceHours ?? {}
  if (!Object.hasOwn(overrides, task.month) && Object.keys(overrides).length >= limits.monthlyReferences) {
    referenceError.value = `最多保存 ${limits.monthlyReferences} 个月的手动参考值，请先将不再使用的月份恢复自动计算。当前修改未保存。`; return
  }
  if (overrides[task.month] !== task.value) {
    props.state.monthlyReferenceHours = { ...overrides, [task.month]: task.value }
    emit('change', { silent: true })
  }
  if (props.state.month === task.month) { referenceSaved.value = true; referenceEdited = false }
}
function scheduleReference(immediate = false) {
  if (!referenceEdited) return
  cancelReferenceTask(); referenceError.value = ''
  const value = Number(referenceDraft.value)
  if (String(referenceDraft.value).trim() === '' || !Number.isFinite(value) || value < 0 || value > 744) {
    referenceError.value = '本月参考工时需为 0–744 小时的有效数值，当前修改未保存。'; return
  }
  const task: ReferenceTask = { timer: 0 as unknown as ReturnType<typeof setTimeout>, state: props.state, month: props.state.month, value }
  referenceTask = task
  if (immediate) flushReferenceTask()
  else task.timer = setTimeout(() => { if (referenceTask === task) flushReferenceTask() }, autosaveDelay)
}
function inputReference(event: Event) {
  referenceEdited = true; referenceSaved.value = false
  referenceDraft.value = (event.target as HTMLInputElement).value
  scheduleReference()
}
function resetReferenceHours() {
  cancelReferenceTask(); referenceError.value = ''; referenceSaved.value = true; referenceEdited = false
  const overrides = { ...props.state.monthlyReferenceHours }
  delete overrides[props.state.month]
  props.state.monthlyReferenceHours = overrides
  referenceDraft.value = monthReference.value.hours
  notice(`${props.state.month} 已恢复按月工作日 × 8 小时计算参考工时。`)
}
function openEditor(kind: 'employee' | 'shift' | 'separation', event?: Event) {
  editorTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null
  editor.value = kind
  if (kind !== 'separation') return
  void nextTick(() => {
    if (editor.value !== kind || !editorElement.value) return
    editorElement.value.scrollIntoView({ block: 'start', behavior: 'auto' })
    editorElement.value.querySelector<HTMLInputElement>('input:not([disabled]):not([type="hidden"])')?.focus({ preventScroll: true })
  })
}
function closeEditor() {
  const trigger = editorTrigger
  editor.value = null; editorTrigger = null; error.value = ''
  void nextTick(() => {
    if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus()
  })
}
function openEmployee(employee?: Employee, event?: Event) {
  if (!employee && props.state.employees.length >= limits.employees) { error.value = `最多支持 ${limits.employees} 位员工，请先删除不再使用的人员。`; return }
  Object.assign(employeeDraft, employee ? { ...employee, avatar: employee.avatar ?? null, minHoursPerMonth: employee.minHoursPerMonth ?? null, minHoursPerWeek: employee.minHoursPerWeek ?? 0, eligibleShiftIds: [...employee.eligibleShiftIds], unavailableDates: [...employee.unavailableDates] } : { id: '', name: '', role: '', group: '', color: '#d7e8f8', avatar: null, minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 48, eligibleShiftIds: props.state.shifts.map(shift => shift.id), unavailableDates: [] })
  openEditor('employee', event); error.value = ''; feedback.value = ''; pendingDelete.value = null
}
function settingsId(prefix: string) { return `${prefix}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')}` }
function saveEmployee(profile: { name: string; role: string; group: string; avatarChanged: boolean; avatar: string | null }) {
  Object.assign(employeeDraft, { name: profile.name, role: profile.role, group: profile.group })
  if (!employeeDraft.id && props.state.employees.length >= limits.employees) { error.value = `最多支持 ${limits.employees} 位员工。`; return }
  if (!validText(employeeDraft.name, limits.employeeText, '员工姓名') || !validText(employeeDraft.role, limits.employeeText, '岗位', true) || !validText(employeeDraft.group, limits.employeeText, '分组', true)) return
  if (props.state.employees.some(employee => employee.id !== employeeDraft.id && employee.name === employeeDraft.name.trim())) { error.value = '已有同名员工，请在姓名后增加标识以便区分。'; return }
  if (profile.avatarChanged && profile.avatar !== null && !isAvatarData(profile.avatar)) { error.value = '头像格式无效，请重新上传图片或移除头像。'; return }
  const existing = props.state.employees.findIndex(item => item.id === employeeDraft.id)
  if (employeeDraft.id && existing < 0) { error.value = '该成员已不存在，请关闭编辑后重新添加。'; return }
  // Basic-profile forms deliberately merge the latest hours, eligibility and leave. Saving
  // an older open profile must never undo card edits or a leave-dialog save.
  const current = existing >= 0 ? props.state.employees[existing]! : { id: settingsId('employee'), avatar: null, minHoursPerMonth: null, minHoursPerWeek: 40, maxHoursPerWeek: 48, unavailableDates: [], eligibleShiftIds: props.state.shifts.map(shift => shift.id) }
  const employee: Employee = { ...current, ...(profile.avatarChanged ? { avatar: profile.avatar } : {}), name: employeeDraft.name.trim(), role: employeeDraft.role.trim(), group: employeeDraft.group.trim(), color: employeeDraft.color, eligibleShiftIds: [...current.eligibleShiftIds], unavailableDates: [...current.unavailableDates] }
  if (existing >= 0) props.state.employees.splice(existing, 1, employee)
  else props.state.employees.push(employee)
  closeEditor(); notice(existing >= 0 ? '成员基本资料已保存，工时、可上班次与请假日期保持不变。' : '成员已添加。可直接在成员卡片设置工时、可上班次，并打开日历设置请假。')
}
function openShift(shift?: Shift, event?: Event) {
  if (!shift && props.state.shifts.length >= limits.shifts) { error.value = `最多支持 ${limits.shifts} 个班次，请先删除不再使用的班次。`; return }
  Object.assign(shiftDraft, shift ? { ...shift, staffingMode: shift.staffingMode ?? 'minimum', normalAllowance: shift.normalAllowance ?? 0 } : { id: '', name: '', shortName: '', start: '08:00', end: '16:00', color: colors[props.state.shifts.length % colors.length], required: 1, staffingMode: 'minimum', normalAllowance: 0 })
  openEditor('shift', event); error.value = ''; feedback.value = ''; pendingDelete.value = null
}
function saveShift() {
  if (!shiftDraft.id && props.state.shifts.length >= limits.shifts) { error.value = `最多支持 ${limits.shifts} 个班次。`; return }
  if (!validText(shiftDraft.name, limits.shiftName, '班次名称') || !validText(shiftDraft.shortName, limits.shortName, '日历简称')) return
  if (props.state.shifts.some(shift => shift.id !== shiftDraft.id && shift.name === shiftDraft.name.trim())) { error.value = '班次名称已存在，请使用不同名称。'; return }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftDraft.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftDraft.end) || shiftDraft.start === shiftDraft.end) { error.value = '请填写有效的起止时间，开始和结束不能相同。'; return }
  if (shiftDraft.staffingMode !== 'minimum' && shiftDraft.staffingMode !== 'fixed') { error.value = '请选择每日最少人数或每日固定人数。'; return }
  if (!Number.isInteger(Number(shiftDraft.required)) || Number(shiftDraft.required) < 0 || Number(shiftDraft.required) > limits.required) { error.value = `${shiftStaffingLabel.value}需要为 0–${limits.required} 的整数。`; return }
  const allowance = shiftDraft.normalAllowance
  if (!validAllowance(allowance)) return
  if (!/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/.test(shiftDraft.color)) { error.value = '请选择有效的班次颜色。'; return }
  const shift: Shift = { ...shiftDraft, id: shiftDraft.id || settingsId('shift'), name: shiftDraft.name.trim(), shortName: shiftDraft.shortName.trim(), required: Number(shiftDraft.required), staffingMode: shiftDraft.staffingMode, normalAllowance: Number(allowance) }
  const existing = props.state.shifts.findIndex(item => item.id === shift.id)
  if (existing >= 0) props.state.shifts.splice(existing, 1, shift)
  else { props.state.shifts.push(shift); for (const employee of props.state.employees) employee.eligibleShiftIds.push(shift.id) }
  closeEditor(); notice(existing >= 0 ? '班次已更新。已有排班将使用新的班次时间，请检查规则冲突。' : '班次已添加，默认所有员工可排此班；可在人员管理中调整。')
}
function validAllowance(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > limits.allowance || Number(Number(value).toFixed(2)) !== Number(value)) { error.value = `班次津贴需为 0–${limits.allowance} 元，最多保留两位小数。`; return false }
  return true
}
function requestDelete(type: 'employee' | 'shift' | 'separation', id: string, name: string) {
  if (type === 'shift' && props.state.shifts.length <= 1) { error.value = '至少需要保留一个班次。'; return }
  pendingDelete.value = { type, id, name }; error.value = ''; feedback.value = ''; editor.value = null
}
function cleanSeparationGroups() {
  const employeeIds = new Set(props.state.employees.map(employee => employee.id))
  const shiftIds = new Set(props.state.shifts.map(shift => shift.id))
  props.state.rules.separationGroups = separationGroups.value.flatMap(group => {
    const members = group.employeeIds.filter(id => employeeIds.has(id))
    const shifts = group.shiftIds.filter(id => shiftIds.has(id))
    // Empty originally means all shifts. Deleting the last explicitly selected
    // shift must remove the group instead of silently broadening its scope.
    if (members.length < 2 || (group.shiftIds.length > 0 && shifts.length === 0)) return []
    return [{ ...group, employeeIds: members, shiftIds: shifts }]
  })
}
function confirmDelete() {
  const item = pendingDelete.value; if (!item) return
  if (item.type === 'employee') {
    props.state.employees = props.state.employees.filter(employee => employee.id !== item.id)
    props.state.assignments = props.state.assignments.filter(assignment => assignment.employeeId !== item.id)
    delete props.payroll.employeeSalaries[item.id]
  } else if (item.type === 'shift') {
    if (props.state.shifts.length <= 1) { error.value = '至少需要保留一个班次。'; pendingDelete.value = null; return }
    props.state.shifts = props.state.shifts.filter(shift => shift.id !== item.id)
    props.state.assignments = props.state.assignments.filter(assignment => assignment.shiftId !== item.id)
    for (const employee of props.state.employees) employee.eligibleShiftIds = employee.eligibleShiftIds.filter(id => id !== item.id)
    if (props.state.rules.nonConsecutiveShifts) {
      const remaining = props.state.rules.nonConsecutiveShifts.filter(rule => rule.shiftId !== item.id)
      if (remaining.length) props.state.rules.nonConsecutiveShifts = remaining
      else delete props.state.rules.nonConsecutiveShifts
    }
    if (props.state.rules.weeklyShiftLimits) {
      const remaining = props.state.rules.weeklyShiftLimits.filter(rule => rule.shiftId !== item.id)
      if (remaining.length) props.state.rules.weeklyShiftLimits = remaining
      else delete props.state.rules.weeklyShiftLimits
    }
    for (const field of ['dateShiftMultipliers'] as const) {
      for (const [date, entries] of Object.entries(props.payroll[field] ?? {})) {
        delete entries[item.id]
        if (!Object.keys(entries).length) delete props.payroll[field]![date]
      }
    }
  } else {
    props.state.rules.separationGroups = separationGroups.value.filter(group => group.id !== item.id)
  }
  cleanSeparationGroups()
  pendingDelete.value = null; notice(item.type === 'separation' ? `已删除「${item.name}」互斥规则，现有排班保持不变。` : `已删除${item.name}及其关联排班，并清理关联规则。`)
}
function savePersonalRules() {
  if (!Number.isFinite(Number(rulesDraft.minRestHours)) || Number(rulesDraft.minRestHours) < 0 || Number(rulesDraft.minRestHours) > limits.minRestHours) { error.value = `班间最短休息需在 0–${limits.minRestHours} 小时之间。`; return }
  if (!Number.isInteger(Number(rulesDraft.maxConsecutiveDays)) || Number(rulesDraft.maxConsecutiveDays) < 1 || Number(rulesDraft.maxConsecutiveDays) > 31) { error.value = '连续工作上限需要为 1–31 天的整数。'; return }
  Object.assign(props.state.rules, { minRestHours: Number(rulesDraft.minRestHours), maxConsecutiveDays: Number(rulesDraft.maxConsecutiveDays) })
  notice('个人休息与连续工作规则已保存，现有排班会重新检查冲突。下方班次限制按行保存。')
}
function saveTeamRules() {
  if (weekdayDraftError.value) { error.value = weekdayDraftError.value; return }
  delete props.state.rules.balanceWeekends
  if (weekdayWeightsEnabled.value) props.state.rules.weekdayWeights = { days: [...weekdayDays.value].sort((a, b) => a - b), percent: Number(weekdayPercent.value) }
  else delete props.state.rules.weekdayWeights
  notice('团队上班权重已保存，现有排班会重新检查冲突。人员互斥按组保存。')
}
function openSeparation(group?: SeparationGroup, event?: Event) {
  if (!group && separationGroups.value.length >= limits.separationGroups) { error.value = `最多支持 ${limits.separationGroups} 个互斥组，请先删除不再使用的规则。`; return }
  Object.assign(separationDraft, group ? { ...group, employeeIds: [...group.employeeIds], shiftIds: [...group.shiftIds] } : { id: '', name: '', employeeIds: [], shiftIds: [] })
  separationAllShifts.value = !group?.shiftIds.length
  openEditor('separation', event); pendingDelete.value = null; error.value = ''; feedback.value = ''
}
function saveSeparation() {
  if (!separationDraft.id && separationGroups.value.length >= limits.separationGroups) { error.value = `最多支持 ${limits.separationGroups} 个互斥组。`; return }
  if (!validText(separationDraft.name, limits.groupName, '互斥规则名称')) return
  if (separationGroups.value.some(group => group.id !== separationDraft.id && group.name === separationDraft.name.trim())) { error.value = '已有同名互斥规则，请使用不同名称。'; return }
  const employeeIds = [...new Set(separationDraft.employeeIds)].filter(id => props.state.employees.some(employee => employee.id === id))
  const shiftIds = separationAllShifts.value ? [] : [...new Set(separationDraft.shiftIds)].filter(id => props.state.shifts.some(shift => shift.id === id))
  if (employeeIds.length < 2) { error.value = '互斥规则至少需要选择 2 位员工。'; return }
  if (!separationAllShifts.value && !shiftIds.length) { error.value = '请选择至少一个适用班次，或勾选适用于全部班次。'; return }
  const group: SeparationGroup = { id: separationDraft.id || settingsId('separation'), name: separationDraft.name.trim(), employeeIds, shiftIds }
  const existing = separationGroups.value.findIndex(item => item.id === group.id)
  props.state.rules.separationGroups = existing < 0 ? [...separationGroups.value, group] : separationGroups.value.map(item => item.id === group.id ? group : item)
  closeEditor(); notice('互斥规则已保存。同一天的同一个适用班次，组内最多安排 1 人；现有排班会检查冲突。')
}
function separationMembers(group: SeparationGroup) { return props.state.employees.filter(employee => group.employeeIds.includes(employee.id)).map(employee => employee.name).join('、') }
function separationShifts(group: SeparationGroup) { return group.shiftIds.length ? props.state.shifts.filter(shift => group.shiftIds.includes(shift.id)).map(shift => shift.name).join('、') : '全部班次（含以后新增的班次）' }
</script>

<template>
  <section class="sp-settings" tabindex="-1">
    <p v-if="feedback" class="sp-settings-message" role="status">✓ {{ feedback }}</p>
    <p v-if="error && editor !== 'shift'" class="sp-settings-message sp-settings-error" role="alert">{{ error }}</p>
    <div v-if="pendingDelete" class="sp-settings-confirm" role="alertdialog" aria-modal="false" :aria-label="`确认删除${pendingDelete.name}`">
      <div><strong>删除「{{ pendingDelete.name }}」？</strong><p>{{ pendingDelete.type === 'separation' ? '删除后将不再限制这组人员同日同班，现有排班保持不变。' : '同时移除所有关联排班（含已锁定的安排），并清理不再适用的关联规则。' }}此操作无法撤销。</p></div>
      <div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="pendingDelete = null">保留</button><button type="button" class="sp-settings-button sp-settings-danger" @click="confirmDelete">确认删除</button></div>
    </div>

    <template v-if="section === 'team'">
      <header class="sp-settings-heading"><div><p>设置人员的班次资格、月 / 周工时与请假。</p></div><button class="sp-settings-button sp-settings-primary" :disabled="state.employees.length >= limits.employees" @click="openEmployee(undefined, $event)"><span aria-hidden="true">＋</span> 添加员工</button></header>
      <section class="sp-settings-config-card sp-settings-month-reference" aria-labelledby="sp-reference-heading">
        <div class="sp-settings-reference-body">
          <div class="sp-settings-reference-summary">
            <h3 id="sp-reference-heading">月参考工时 <small aria-label="月参考工时当前月份">{{ state.month }}</small></h3>
            <div><strong>{{ monthReference.hours }}</strong><span>小时 / 月</span><span class="sp-settings-label">{{ monthReference.custom ? '手动设置' : '自动计算' }}</span></div>
            <p>{{ monthReference.workdays }} 个工作日 × 8 小时 = {{ monthReference.suggestedHours }} 小时</p>
          </div>
          <form class="sp-settings-reference-form" novalidate @submit.prevent="scheduleReference(true)">
            <label class="sp-settings-field">本月参考工时<span class="sp-settings-input-unit"><input :value="referenceDraft" type="number" min="0" max="744" step="any" aria-label="手动月参考工时" :aria-invalid="!!referenceError" @input="inputReference" @blur="scheduleReference(true)" /><span>小时</span></span></label>
            <div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="resetReferenceHours">恢复自动</button></div>
          </form>
        </div>
        <p v-if="referenceError" class="sp-settings-inline-error" role="alert">{{ referenceError }}</p>
        <p v-else class="sp-settings-auto-status" role="status">{{ referenceSaved ? '月参考工时已自动保存' : '输入后自动保存，仅影响当前月份' }}</p>
        <p v-if="!monthReference.verified" class="sp-settings-calendar-warning" role="status">日历待核对，当前建议值为估算，可手动设置。</p>
        <details class="sp-settings-help-details sp-settings-reference-details"><summary>参考工时说明</summary><p>月参考值按本月工作日 × 8 小时计算，包含法定节假日、调休补班及手动日历标记。未单独设置的成员，月最低工时跟随参考值；月份在顶部切换。</p><p>月最低和周最低都是必须满足的条件，设为 0 可关闭对应最低限制。周工时按周一至周日计算。月初、月末先按当月所占天数折算周最低；同一周月外已排工时可抵扣整周最低，本月实际最低取「折算值」与「整周最低减去月外已排工时后的剩余缺口」中较小的非负值。周最高仍计入已知跨月排班。排班精确到分钟，最低向上、最高向下取整。</p></details>
      </section>
      <div class="sp-settings-toolbar"><label class="sp-settings-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input v-model="employeeSearch" type="search" placeholder="搜索姓名、岗位或分组" aria-label="搜索员工" /></label><span>{{ state.employees.length }} / {{ limits.employees }} 位团队成员</span></div>
      <p v-if="state.employees.length >= limits.employees" class="sp-settings-hint">已达到 {{ limits.employees }} 人上限，可以编辑现有人员，或删除不再使用的人员后新增。</p>
      <p class="sp-settings-inline-guide">工时与可上班次自动保存；每周最高与最低至少相差 8 小时。无效输入会保留原设置。</p>
      <div class="sp-settings-employee-grid">
        <article v-for="employee in displayedEmployees" :key="employee.id" :id="`member-${employee.id}`" tabindex="-1" class="sp-settings-employee-card">
          <div class="sp-settings-person"><EmployeeAvatar class="sp-settings-avatar" :name="employee.name" :color="employee.color" :avatar="employee.avatar" /><div><h3>{{ employee.name }}</h3><p>{{ employee.role || '未设岗位' }}<span v-if="employee.group"> · {{ employee.group }}</span></p></div><button class="sp-settings-edit" :aria-label="`编辑${employee.name}`" @click="openEmployee(employee, $event)">编辑</button></div>
          <form class="sp-settings-inline-hours" :aria-label="`${employee.name}工时与班次设置`" novalidate @submit.prevent="saveEmployeeHours(employee)">
            <fieldset class="sp-settings-inline-shifts"><legend>可上班次</legend><div class="sp-settings-inline-shift-options"><button v-for="shift in state.shifts" :key="shift.id" type="button" :class="{ selected: hoursDrafts[employee.id]!.eligibleShiftIds.includes(shift.id) }" :style="{ '--shift-color': shift.color }" :aria-label="`${employee.name}可上${shift.name}`" :aria-pressed="hoursDrafts[employee.id]!.eligibleShiftIds.includes(shift.id)" @click="toggleEmployeeShift(employee, shift.id)"><span aria-hidden="true">{{ hoursDrafts[employee.id]!.eligibleShiftIds.includes(shift.id) ? '✓' : '＋' }}</span>{{ shift.name }}</button></div><p v-if="!hoursDrafts[employee.id]!.eligibleShiftIds.length" class="sp-settings-inline-hint">未选择班次，不参与自动排班。</p></fieldset>
            <div class="sp-settings-inline-month">
              <label class="sp-settings-checkbox sp-settings-inline-reference"><input :checked="hoursDrafts[employee.id]!.followReference" type="checkbox" :aria-label="`${employee.name}月最低工时跟随月参考值`" @change="setHoursFollow(employee, $event)" /><span>月最低跟随参考值</span></label>
              <label class="sp-settings-field">每月最低工时<span class="sp-settings-input-unit"><input :value="hoursDrafts[employee.id]!.followReference ? monthReference.hours : hoursDrafts[employee.id]!.month" type="number" min="0" max="744" step="any" :disabled="hoursDrafts[employee.id]!.followReference" :aria-label="`${employee.name}每月最低工时`" @input="inputHours(employee, 'month', $event)" @blur="scheduleHours(employee, 'month', true)" /><span>小时</span></span></label>
            </div>
            <div class="sp-settings-inline-week">
              <label class="sp-settings-field">每周最低工时<span class="sp-settings-input-unit"><input :value="hoursDrafts[employee.id]!.weekMin" type="number" min="0" max="168" step="any" :aria-label="`${employee.name}每周最低工时`" :aria-invalid="!!hoursDrafts[employee.id]!.errors.week" @input="inputHours(employee, 'weekMin', $event)" @blur="scheduleHours(employee, 'week', true)" /><span>小时</span></span></label>
              <label class="sp-settings-field">每周最高工时<span class="sp-settings-input-unit"><input :value="hoursDrafts[employee.id]!.weekMax" type="number" min="0" max="168" step="any" :aria-label="`${employee.name}每周最高工时`" :aria-invalid="!!hoursDrafts[employee.id]!.errors.week" @input="inputHours(employee, 'weekMax', $event)" @blur="scheduleHours(employee, 'week', true)" /><span>小时</span></span></label>
            </div>
            <p v-for="message in hoursErrors(employee)" :key="message" class="sp-settings-inline-error" role="alert">{{ message }}</p>
            <p v-if="!hoursErrors(employee).length" class="sp-settings-auto-status" role="status">{{ hoursDirty(employee) ? '等待自动保存…' : hoursDrafts[employee.id]!.saved ? '已自动保存' : '自动保存已开启' }}</p>
          </form>
          <div class="sp-settings-card-bottom sp-settings-member-bottom"><button type="button" class="sp-settings-leave-trigger" :aria-label="`设置${employee.name}请假`" @click="openLeave(employee)"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v5m8-5v5M4 11h16m-12 4h2m4 0h2"/></svg><span>{{ employee.unavailableDates.length ? `请假 ${employee.unavailableDates.length} 天` : '设置请假' }}</span></button><button class="sp-settings-remove" :aria-label="`删除${employee.name}`" @click="requestDelete('employee', employee.id, employee.name)">删除</button></div>
        </article>
      </div>
      <div v-if="!displayedEmployees.length" class="sp-settings-empty"><strong>{{ state.employees.length ? '没有找到匹配的成员' : '添加第一位团队成员' }}</strong><p>{{ state.employees.length ? '试试其他姓名、岗位或分组。' : '先建立人员名单，再为大家生成合适的排班。' }}</p></div>
    </template>

    <template v-else-if="section === 'shifts'">
      <header class="sp-settings-heading"><div><p>设置时间、每日人数规则及每班固定津贴，支持跨午夜。{{ state.shifts.length }} / {{ limits.shifts }} 个班次。</p></div><button class="sp-settings-button sp-settings-primary" :disabled="state.shifts.length >= limits.shifts" @click="openShift(undefined, $event)"><span aria-hidden="true">＋</span> 新建班次</button></header>
      <p v-if="state.shifts.length >= limits.shifts" class="sp-settings-hint">已达到 {{ limits.shifts }} 个班次上限，可以编辑或删除现有班次。</p>
      <ShiftDialog v-if="editor === 'shift'" :title="shiftDraft.id ? '编辑班次' : '新建班次'" :error="error" @save="saveShift" @close="closeEditor">
        <div class="sp-settings-form-grid"><label class="sp-settings-field">班次名称<input v-model="shiftDraft.name" :maxlength="limits.shiftName" placeholder="例如：早班" required /></label><label class="sp-settings-field">日历简称<input v-model="shiftDraft.shortName" :maxlength="limits.shortName" placeholder="例如：早" required /></label><label class="sp-settings-field">开始时间<input v-model="shiftDraft.start" type="time" required /></label><label class="sp-settings-field">结束时间<input v-model="shiftDraft.end" type="time" required /></label><fieldset class="sp-settings-staffing-mode"><legend>每日人数规则</legend><div class="sp-settings-staffing-options"><label :class="{ selected: shiftDraft.staffingMode === 'minimum' }"><input v-model="shiftDraft.staffingMode" type="radio" name="shift-staffing-mode" value="minimum" aria-label="人数模式：每日最少人数" /><span><strong>每日最少人数</strong><small>达到下限后，可以增派</small></span></label><label :class="{ selected: shiftDraft.staffingMode === 'fixed' }"><input v-model="shiftDraft.staffingMode" type="radio" name="shift-staffing-mode" value="fixed" aria-label="人数模式：每日固定人数" /><span><strong>每日固定人数</strong><small>按指定人数安排，不增派</small></span></label></div></fieldset><label class="sp-settings-field">{{ shiftStaffingLabel }}<span class="sp-settings-input-unit"><input v-model.number="shiftDraft.required" type="number" min="0" :max="limits.required" step="1" required :aria-label="shiftStaffingLabel" /><span>人</span></span></label><label class="sp-settings-field">班次津贴<span class="sp-settings-input-unit"><input v-model.number="shiftDraft.normalAllowance" type="number" min="0" :max="limits.allowance" step="0.01" required aria-label="班次津贴" /><span>元 / 人 / 班</span></span></label><div class="sp-settings-field sp-settings-full-field">标记颜色<div class="sp-settings-colors"><button v-for="color in colors" :key="color" type="button" :style="{ background: color }" :class="{ active: shiftDraft.color === color }" :aria-label="`选择颜色 ${color}`" :aria-pressed="shiftDraft.color === color" @click="shiftDraft.color = color">{{ shiftDraft.color === color ? '✓' : '' }}</button><label class="sp-settings-custom-color"><input v-model="shiftDraft.color" type="color" aria-label="自定义班次颜色" /></label></div></div></div><p class="sp-settings-soft-note">本班次 {{ shiftDuration }} 小时<span v-if="shiftDraft.end < shiftDraft.start"> · 次日结束；整班津贴归入开始日期，跨月不拆金额</span>。<template v-if="shiftDraft.staffingMode === 'fixed'">每天恰好安排 {{ shiftDraft.required || 0 }} 人，不能少排或增派。固定人数设为 0 时，不安排该班。</template><template v-else>每日最少人数是覆盖下限，排班时可为满足成员最低工时增派。最少人数设为 0 表示不设下限，仍可自动增派该班。</template>津贴按每人每班固定金额发放，每排一次该班领取一次，不按工时折算；津贴设为 0 表示该班没有津贴。</p>
      </ShiftDialog>
      <div class="sp-settings-shift-grid"><article v-for="shift in sortedShifts" :key="shift.id" :id="`shift-${shift.id}`" tabindex="-1" class="sp-settings-shift-card"><div class="sp-settings-shift-top"><span class="sp-settings-shift-mark" :style="{ background: shift.color }">{{ shift.shortName }}</span><div><h3>{{ shift.name }}</h3><p>{{ shift.end < shift.start ? '跨夜班次' : '当日班次' }}</p></div><button class="sp-settings-edit" :aria-label="`编辑${shift.name}`" @click="openShift(shift, $event)">编辑</button></div><div class="sp-settings-shift-time">{{ shift.start }} <span>—</span> {{ shift.end }}<small v-if="shift.end < shift.start">次日</small></div><p class="sp-settings-shift-allowance">班次津贴 <strong>¥ {{ (shift.normalAllowance ?? 0).toFixed(2) }}</strong><span> / 人 / 班</span></p><div class="sp-settings-card-bottom"><div class="sp-settings-staffing-summary"><span class="sp-settings-staffing-badge" :class="shift.staffingMode === 'fixed' ? 'is-fixed' : 'is-minimum'" :data-staffing-mode="shift.staffingMode ?? 'minimum'">{{ shift.staffingMode === 'fixed' ? '每日固定 =' : '每日最少 ≥' }} <strong>{{ shift.required }}</strong> 人</span><small>{{ shift.staffingMode === 'fixed' ? (shift.required === 0 ? '此班停排' : '人数确定') : (shift.required === 0 ? '不设下限，仍可增派' : '允许增派') }}</small></div><button class="sp-settings-remove" :disabled="state.shifts.length <= 1" :aria-label="`删除${shift.name}`" @click="requestDelete('shift', shift.id, shift.name)">删除</button></div></article></div>
      <details class="sp-settings-help-details sp-settings-bottom-help"><summary>班次设置说明</summary><p class="sp-settings-footnote">新增班次默认适用于所有员工。更细的人员限制，请前往「人员管理」设置。<span v-if="state.rules.weekdayWeights">已启用上班权重：每天同时遵守各班的最少 / 固定人数规则；星期占比按团队实际总班数计算。只有最少人数模式允许增派。</span></p></details>
    </template>

    <template v-else-if="section === 'rules'">
      <div class="sp-settings-rule-tabs" role="tablist" aria-label="排班规则类型" @keydown.left.prevent="selectRuleCategory(ruleCategory === 'personal' ? 'team' : 'personal', true)" @keydown.right.prevent="selectRuleCategory(ruleCategory === 'personal' ? 'team' : 'personal', true)" @keydown.home.prevent="selectRuleCategory('personal', true)" @keydown.end.prevent="selectRuleCategory('team', true)">
        <button id="sp-rule-tab-personal" type="button" role="tab" :aria-selected="ruleCategory === 'personal'" aria-controls="sp-rule-panel-personal" :tabindex="ruleCategory === 'personal' ? 0 : -1" @click="selectRuleCategory('personal')">个人规则</button>
        <button id="sp-rule-tab-team" type="button" role="tab" :aria-selected="ruleCategory === 'team'" aria-controls="sp-rule-panel-team" :tabindex="ruleCategory === 'team' ? 0 : -1" @click="selectRuleCategory('team')">团队规则</button>
      </div>
      <section id="sp-rule-panel-personal" v-show="ruleCategory === 'personal'" class="sp-settings-rule-panel" role="tabpanel" aria-labelledby="sp-rule-tab-personal" tabindex="-1">
      <p class="sp-settings-rule-category-note">按每位成员分别检查。月 / 周工时、可上班次和请假，在「成员管理」中设置。</p>
      <form class="sp-settings-config-card" aria-label="个人休息与连续工作规则" @submit.prevent="savePersonalRules">
        <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">01</span><h3>班间充分休息</h3><p>上个班结束到下个班开始，至少保留这段休息时间。</p></div><label class="sp-settings-input-unit"><input v-model.number="rulesDraft.minRestHours" type="number" min="0" :max="limits.minRestHours" step="any" required aria-label="班间最短休息小时数" /><span>小时</span></label></div>
        <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">02</span><h3>控制连续工作</h3><p>达到连续工作上限后，应安排休息或请假日。</p></div><label class="sp-settings-input-unit"><input v-model.number="rulesDraft.maxConsecutiveDays" type="number" min="1" max="31" step="1" required aria-label="最大连续工作天数" /><span>天</span></label></div>
        <div class="sp-settings-form-footer"><p>保存上方两项。下方班次限制按行单独保存。</p><button type="submit" class="sp-settings-button sp-settings-primary">保存个人规则</button></div>
      </form>
      <ShiftRulesPanel :state="state" @change="notice" />
      </section>
      <section id="sp-rule-panel-team" v-show="ruleCategory === 'team'" class="sp-settings-rule-panel" role="tabpanel" aria-labelledby="sp-rule-tab-team" tabindex="-1">
      <p class="sp-settings-rule-category-note">按整个团队或指定人员组共同检查，包括上班权重与同日同班互斥。</p>
      <form class="sp-settings-config-card" aria-label="团队上班权重规则" @submit.prevent="saveTeamRules">
        <section class="sp-settings-weekday-rule" aria-labelledby="sp-weekday-heading">
          <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">01</span><h3 id="sp-weekday-heading">上班权重</h3><p>选择星期，按团队实际总班次数分配指定比例；其余班次在其他星期均分，同时遵守各班最少 / 固定人数规则。</p></div><label class="sp-settings-switch"><input v-model="weekdayWeightsEnabled" type="checkbox" aria-label="启用上班权重" /><span/><small>{{ weekdayWeightsEnabled ? '已开启' : '已关闭' }}</small></label></div>
          <div v-if="weekdayWeightsEnabled" class="sp-settings-weight-options">
            <fieldset class="sp-settings-fieldset sp-settings-weight-days"><legend>选择分配星期 · 可多选</legend><div class="sp-settings-weekday-options"><label v-for="day in weekdayOptions" :key="day.value" class="sp-settings-weekday-option" :class="{ selected: weekdayDays.includes(day.value) }"><input v-model="weekdayDays" type="checkbox" :value="day.value" :aria-label="`上班权重${day.label}`" /><span>{{ day.short }}</span></label></div></fieldset>
            <div class="sp-settings-weight-percent-row">
              <label class="sp-settings-field">所选星期合计占比<span class="sp-settings-input-unit"><input v-model.number="weekdayPercent" type="number" min="0" max="100" step="1" required aria-label="所选星期合计占比" :aria-invalid="!!weekdayDraftError" aria-describedby="sp-weight-percent-help" /><span>%</span></span></label>
              <p id="sp-weight-percent-help" class="sp-settings-hint">填写 0–100 的整数；选择全部七天时须为 100%。按整组班次向上取整，组内各天相差最多 1 班。</p>
            </div>
            <p v-if="weekdayDraftError" class="sp-settings-calendar-warning sp-settings-weight-validation" role="alert">{{ weekdayDraftError }}</p>
            <template v-else>
              <div class="sp-settings-weight-capacity" role="status">
                <strong v-if="weekdayCapacity.maxPercent !== null">占比容量参考上限：{{ weekdayCapacity.maxPercent }}%</strong>
                <strong v-else>按班次人数规则与当前人员容量，未找到可满足的整数比例</strong>
                <p>{{ weekdayCapacity.explanation }}</p>
                <p v-if="weekdayCapacity.maxPercent !== null && Number(weekdayPercent) > weekdayCapacity.maxPercent" class="sp-settings-weight-capacity-warning">当前占比超过容量参考上限，请调整比例或人员配置。保存不会自动降低占比。</p>
              </div>
              <details class="sp-settings-help-details sp-settings-calculation-details"><summary>查看比例计算示例</summary>
              <div class="sp-settings-weight-formula">
                <div class="sp-settings-weight-example-heading"><div><strong>计算示例 · 不作为固定排班数量</strong><p>实际总班数根据每日人数规则与成员工时确定；最少人数班次可增派，固定人数班次不可超过设定值。</p></div><label class="sp-settings-field">完整周演示总班数<span class="sp-settings-input-unit"><input v-model.number="weekdayExampleTotal" type="text" inputmode="numeric" maxlength="7" aria-label="完整周演示总班数" :aria-invalid="!!weekdayExampleError" /><span>班</span></span></label></div>
                <p v-if="weekdayExampleError" class="sp-settings-weight-capacity-warning" role="alert">{{ weekdayExampleError }}</p>
                <template v-else><p>假设完整周排 {{ weekdayExampleTotal }} 班，{{ weekdaySelectedLabel }}合计应排 ⌈{{ weekdayExampleTotal }} × {{ weekdayPercent }}%⌉ = {{ weekdayFullSelected }} 班，其余星期共 {{ Number(weekdayExampleTotal) - weekdayFullSelected }} 班。</p><p>严格覆盖下，完整周至少需要 {{ weekdayMinimum }} 班；固定人数班次不能增派，实际还需满足成员工时与休息规则。</p><p v-if="Number(weekdayExampleTotal) < weekdayMinimum || Number(weekdayExampleTotal) > weekdayMaximum" class="sp-settings-weight-capacity-warning">此演示班数超出当前人数规则或每人每天一班的容量范围，仅用于说明比例计算。</p><p v-else-if="weekdayExampleBelowMinimum" class="sp-settings-weight-capacity-warning">此示例分配后，有些日期未达到严格覆盖所需人数，需调整班次人数模式、总班数或占比后重新排班。</p></template>
              </div>
              <section v-if="!weekdayExampleError" class="sp-settings-weight-preview" aria-label="本月上班权重计算示例">
                <div class="sp-settings-weight-preview-heading"><h4>{{ state.month }} · 按演示总班数分段计算</h4><span>本月示例共 <strong class="sp-settings-weight-month-total">{{ weekdayMonthlyTotal }}</strong> 班</span></div>
                <div class="sp-settings-weight-weeks">
                  <article v-for="week in weekdayPreviewWeeks" :key="week.id" class="sp-settings-weight-week" :data-week="week.id">
                    <header><strong>{{ week.dates[0]!.slice(5) }} — {{ week.dates[week.dates.length - 1]!.slice(5) }}</strong><span>{{ week.dates.length === 7 ? '完整周' : '部分周' }}</span></header>
                    <dl><div><dt>已选星期</dt><dd><strong class="sp-settings-weight-selected">{{ week.selectedTarget }}</strong> 班</dd></div><div><dt>其余星期</dt><dd><strong class="sp-settings-weight-other">{{ week.otherTarget }}</strong> 班</dd></div><div><dt>合计</dt><dd><strong class="sp-settings-weight-total">{{ week.totalTarget }}</strong> 班</dd></div></dl>
                    <details><summary>示例逐日人数范围</summary><ul><li v-for="date in week.dates" :key="date" :class="{ selected: week.selectedDates.includes(date) }"><span>{{ date.slice(5) }} {{ dayWeightLabel(date) }}</span><strong>{{ dayWeightRange(week, date) }} 班</strong></li></ul><p>按上方演示总班数计算，同组内各天相差最多 1 班。实际增派后将按新的总班数重新计算，此示例不代表已满足工时和各班最少 / 固定人数规则。</p></details>
                  </article>
                </div>
              </section>
              </details>
            </template>
            <p class="sp-settings-hint">比例是硬性规则，同时遵守各班人数模式与工时限制。</p>
            <details class="sp-settings-help-details"><summary>权重与人数规则说明</summary><p class="sp-settings-soft-note"><strong>占比是硬性规则，人数模式同时生效。</strong>完整周以实际总班数计算，所选星期合计向上取整，组内各天均摊。月初、月末只保留当月出现的星期份额，缺失星期的份额不重新分配。为满足工时，只能向最少人数班次增派。固定人数班次须恰好满足人数，最少人数班次须达到下限，星期占比及其他规则也须同时满足。规则冲突时会提示无法排班。</p></details>
          </div>
          <p v-else class="sp-settings-hint">关闭时按各班最少 / 固定人数规则安排。最少人数班次可为满足成员最低工时增派，固定人数班次不增派；不额外限制星期占比。</p>
        </section>
        <div class="sp-settings-form-footer"><p>保存上方权重设置。下方人员互斥按组单独保存。</p><button type="submit" class="sp-settings-button sp-settings-primary">保存团队规则</button></div>
      </form>
      <section class="sp-settings-config-card sp-settings-separation">
        <div class="sp-settings-card-heading"><div><h3>同日同班互斥</h3><p>指定人员互相错开，每个适用班次中，组内最多安排 1 人。当前 {{ separationGroups.length }} / {{ limits.separationGroups }} 组。</p></div><button type="button" class="sp-settings-button" :disabled="state.employees.length < 2 || separationGroups.length >= limits.separationGroups" @click="openSeparation(undefined, $event)">＋ 添加互斥组</button></div>
        <p v-if="separationGroups.length >= limits.separationGroups" class="sp-settings-hint">已达到 {{ limits.separationGroups }} 个互斥组上限，可以编辑或删除已有规则。</p>
        <form v-if="editor === 'separation'" ref="editorElement" class="sp-settings-separation-editor" @submit.prevent="saveSeparation">
          <div class="sp-settings-card-heading"><h3>{{ separationDraft.id ? '编辑互斥组' : '新增互斥组' }}</h3><button type="button" class="sp-settings-icon-button" aria-label="关闭互斥组编辑" @click="closeEditor">×</button></div>
          <label class="sp-settings-field">规则名称<input v-model="separationDraft.name" :maxlength="limits.groupName" required placeholder="例如：主管轮值错开" /></label>
          <fieldset class="sp-settings-fieldset"><legend>选择互斥人员 · 至少 2 人<span class="sp-settings-selection-count">已选 {{ separationDraft.employeeIds.length }} 人</span></legend><div class="sp-settings-member-options"><label v-for="employee in state.employees" :key="employee.id" class="sp-settings-checkbox sp-settings-member-option" :class="{ selected: separationDraft.employeeIds.includes(employee.id) }"><input v-model="separationDraft.employeeIds" type="checkbox" :value="employee.id"/><span>{{ employee.name }}<small>{{ employee.role || employee.group || '团队成员' }}</small></span></label></div></fieldset>
          <fieldset class="sp-settings-fieldset"><legend>适用班次</legend><label class="sp-settings-checkbox"><input v-model="separationAllShifts" type="checkbox"/><span>适用于全部班次（包括以后新增的班次）</span></label><div v-if="!separationAllShifts" class="sp-settings-choice-row sp-settings-specific-shifts"><label v-for="shift in state.shifts" :key="shift.id" class="sp-settings-checkbox"><input v-model="separationDraft.shiftIds" type="checkbox" :value="shift.id"/><span class="sp-settings-dot" :style="{ background: shift.color }"/>{{ shift.name }}</label></div></fieldset>
          <p class="sp-settings-soft-note">例如选择甲、乙、丙三人后，任意两人都不能在同一天上同一个适用班次；可以分别上早班、晚班，或安排休息。</p>
          <div class="sp-settings-form-footer"><p>保存后立即检查现有排班，重新生成时自动遵守。</p><div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="closeEditor">取消</button><button type="submit" class="sp-settings-button sp-settings-primary">保存互斥组</button></div></div>
        </form>
        <div v-if="separationGroups.length" class="sp-settings-separation-list"><article v-for="group in separationGroups" :key="group.id" class="sp-settings-separation-group"><div class="sp-settings-separation-title"><h3>{{ group.name }}</h3><span class="sp-settings-label">{{ group.employeeIds.length }} 人互斥</span><div class="sp-settings-actions"><button type="button" class="sp-settings-edit" :aria-label="`编辑互斥组${group.name}`" @click="openSeparation(group, $event)">编辑</button><button type="button" class="sp-settings-remove" :aria-label="`删除互斥组${group.name}`" @click="requestDelete('separation', group.id, group.name)">删除</button></div></div><p class="sp-settings-separation-names">{{ separationMembers(group) }}</p><p class="sp-settings-separation-scope">适用：{{ separationShifts(group) }}<span>同日同班，组内最多 1 人</span></p></article></div>
        <p v-else-if="editor !== 'separation'" class="sp-settings-hint">{{ state.employees.length < 2 ? '先添加至少 2 位员工，即可设置人员互斥。' : '暂无互斥规则。可添加多组，同一位员工也可以属于多个组。' }}</p>
      </section>
      </section>
      <details class="sp-settings-help-details sp-settings-bottom-help"><summary>排班规则说明</summary><p>自动排班综合考虑已排工时、班次分配与人员互斥。启用权重后，按实际班数核对星期占比。与其他限制冲突时会提示原因并保留原排班，锁定安排保持不变。</p></details>
    </template>

    <EmployeeDialog v-if="editor === 'employee'" :key="employeeDraft.id || 'new'" :employee="employeeDraft" :error="error" @save="saveEmployee" @close="closeEditor" />
    <LeaveCalendarDialog v-if="leaveEmployee" :key="leaveEmployee.id" :employee="leaveEmployee" :initial-month="state.month" @save="saveLeave" @close="leaveEmployeeId = ''" />
  </section>
</template>

<style scoped>
.sp-settings-reference-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.sp-settings-reference-heading>div{flex:1;min-width:180px}.sp-settings-reference-heading p{font-size:12px;line-height:1.7;color:#758a93;margin-top:7px}.sp-settings-reference-heading>.sp-settings-field{width:190px;max-width:100%}.sp-settings-reference-body{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-top:20px;flex-wrap:wrap}.sp-settings-reference-summary{flex:1;min-width:220px}.sp-settings-reference-summary>div{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}.sp-settings-reference-summary strong{font-size:32px;font-variant-numeric:tabular-nums;font-weight:650;color:#245b4e;line-height:1.3}.sp-settings-reference-summary>div>span:not(.sp-settings-label){font-size:12px;color:#7a8f97}.sp-settings-reference-summary p{font-size:12px;color:#71878e;line-height:1.8;margin-top:8px}.sp-settings-reference-summary p+p{font-size:11px;margin-top:1px}.sp-settings-reference-form{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;max-width:100%}.sp-settings-reference-form>.sp-settings-field{width:180px;max-width:100%;flex:1}.sp-settings-reference-form>.sp-settings-actions{flex-wrap:wrap}.sp-settings-calendar-warning{margin-top:16px!important;background:#fff8e9;border:1px solid #eedcb3;border-radius:8px;color:#957542;font-size:12px;line-height:1.7;padding:10px 12px}.sp-settings-month-reference>.sp-settings-hint{padding-top:12px;margin-top:16px!important;border-top:1px solid #edf1f2;color:#7b9096}.sp-settings-month-minimum>.sp-settings-hint{margin-top:0!important;font-weight:400}.sp-settings-month-minimum>.sp-settings-checkbox{font-weight:400;align-items:flex-start;min-height:24px}.sp-settings-month-minimum .sp-settings-checkbox input{width:16px;height:16px;min-height:16px;padding:0;margin-top:2px}.sp-settings-employee-hours{display:grid;gap:9px;margin:0 0 16px;font-size:12px}.sp-settings-employee-hours>div{display:flex;justify-content:space-between;align-items:baseline;gap:6px;flex-wrap:wrap}.sp-settings-employee-hours dt{color:#83979f}.sp-settings-employee-hours dd{margin:0;color:#4d6973;text-align:right;font-variant-numeric:tabular-nums}.sp-settings-employee-hours small{color:#859b95;font-size:10px;white-space:nowrap;margin-left:4px}
@media(max-width:720px){.sp-settings-reference-body{gap:18px}.sp-settings-reference-summary{min-width:0;flex-basis:100%}.sp-settings-reference-form{width:100%}.sp-settings-reference-form>.sp-settings-field{min-width:120px}.sp-settings-reference-heading>.sp-settings-field{width:100%}.sp-settings-reference-summary strong{font-size:29px}}
@media(max-width:520px){.sp-settings-employee-form-grid{grid-template-columns:1fr!important}.sp-settings-reference-form>.sp-settings-field{flex-basis:100%}.sp-settings-reference-form>.sp-settings-actions{width:100%}.sp-settings-reference-form>.sp-settings-actions>.sp-settings-button{flex:1}}
.sp-settings-shift-top h3{overflow-wrap:anywhere}.sp-settings-shift-mark{min-width:44px;min-height:44px;height:auto!important;max-width:96px;width:auto!important;padding:8px;overflow-wrap:anywhere;font-size:15px!important;text-align:center}
.sp-settings{color:#263c45;font-size:14px;max-width:1440px;margin:0 auto}.sp-settings *{box-sizing:border-box}.sp-settings button,.sp-settings input{font:inherit}.sp-settings button{cursor:pointer;transition:background .15s,box-shadow .15s}.sp-settings button:disabled{cursor:not-allowed;opacity:.38}.sp-settings input:focus-visible,.sp-settings button:focus-visible{outline:3px solid #99ddd4;outline-offset:3px}.sp-settings h2,.sp-settings h3,.sp-settings p{margin:0}.sp-settings h2{font-size:19px;font-weight:650;line-height:1.4;letter-spacing:-.5px}.sp-settings h3{font-size:15px;font-weight:650}.sp-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:18px}.sp-settings-heading p{color:#829099;line-height:1.7;margin-top:0;font-size:13px}.sp-settings-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;white-space:nowrap;padding:9px 16px;border:1px solid #dce5e8;border-radius:9px;background:#fff;color:#4e626b;font-weight:600!important;font-size:13px!important}.sp-settings-button:hover{background:#f1f6f5}.sp-settings-primary{background:#245b4e;border-color:#245b4e;color:#fff;box-shadow:0 3px 8px #245b4e14}.sp-settings-primary:hover{background:#1d4a3f}.sp-settings-actions{display:flex;gap:9px}.sp-settings-message{padding:13px 16px!important;margin-bottom:18px!important;border:1px solid #bee5d8;border-radius:10px;background:#ecf9f3;color:#247863;line-height:1.6}.sp-settings-error{background:#fff1ef;color:#ba5145;border-color:#f3cec5}.sp-settings-confirm{display:flex;gap:20px;justify-content:space-between;align-items:center;background:#fff8ef;border:1px solid #eedbbc;padding:20px;border-radius:14px;margin-bottom:20px}.sp-settings-confirm p{font-size:12px;color:#95734f;line-height:1.6;margin-top:7px}.sp-settings-danger{background:#b95047;color:#fff;border-color:#b95047}.sp-settings-danger:hover{background:#a53f37}.sp-settings-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.sp-settings-toolbar>span{font-size:12px;color:#8a979c}.sp-settings-search{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #e0e7eb;border-radius:9px;padding:9px 12px;max-width:350px;flex:1}.sp-settings-search svg{width:17px;fill:none;stroke:#93a3aa;stroke-width:1.7;flex-shrink:0}.sp-settings-search input{border:0;background:none;width:100%;min-width:0;font-size:13px;color:#344d55}.sp-settings-search input:focus-visible{outline:none}.sp-settings-search:focus-within{border-color:#245b4e;box-shadow:0 0 0 3px #245b4e10}.sp-settings-editor,.sp-settings-config-card{padding:24px;border:1px solid #e1e9eb;border-radius:14px;background:#fff;margin-bottom:20px}.sp-settings-editor{border-color:#96d5cc;box-shadow:0 3px 16px #174d4010}.sp-settings-card-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:22px}.sp-settings-card-heading p{font-size:12px;color:#83939b;margin-top:7px}.sp-settings-icon-button{border:0;background:#f1f5f5;border-radius:8px;width:32px;height:32px;color:#698089;font-size:22px!important}.sp-settings-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.sp-settings-field{display:flex;flex-direction:column;gap:9px;font-size:12px;font-weight:600;color:#657982;min-width:0}.sp-settings-field input{padding:10px 12px;border:1px solid #dfe7e9;border-radius:8px;width:100%;min-width:0;background:#fcfdfd;color:#304d56;min-height:40px;font-weight:400}.sp-settings-field input:focus{border-color:#47b5a8;outline:none;box-shadow:0 0 0 3px #245b4e10}.sp-settings-input-unit{display:flex;align-items:center;gap:8px;border:1px solid #dfe7e9;border-radius:8px;min-height:40px;background:#fcfdfd;padding-right:12px;min-width:0}.sp-settings-input-unit input{border:0;background:none;width:100%;min-width:0;padding:10px 12px;color:#304d56}.sp-settings-input-unit input:focus-visible{outline:none;box-shadow:none}.sp-settings-input-unit:focus-within{border-color:#47b5a8;box-shadow:0 0 0 3px #245b4e10}.sp-settings-input-unit>span{font-size:12px;color:#93a1a7;white-space:nowrap;font-weight:400}.sp-settings-fieldset{border:0;padding:0;margin:25px 0 0;min-width:0}.sp-settings-fieldset legend{font-size:12px;color:#657982;font-weight:600;margin-bottom:12px}.sp-settings-choice-row{display:flex;gap:12px;flex-wrap:wrap}.sp-settings-checkbox{display:flex;gap:8px;align-items:center;color:#49646a;line-height:1.5;font-size:13px}.sp-settings-checkbox input{accent-color:#245b4e;width:16px;height:16px;flex-shrink:0;margin:0}.sp-settings-checkbox small{color:#99a5a9;font-size:11px}.sp-settings-dot{width:9px;height:9px;display:inline-block;border-radius:50%;box-shadow:0 0 0 1px #364b4215}.sp-settings-hint{font-size:12px;color:#94a2a8;line-height:1.7;margin-top:10px!important}.sp-settings-leave-row{display:flex;gap:12px;align-items:flex-end}.sp-settings-leave-row>.sp-settings-field{flex:1}.sp-settings-leave-dates{display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow:auto;margin-top:14px}.sp-settings-leave-dates button{background:#f0f7f5;border:1px solid #dceae4;padding:5px 8px;border-radius:5px;color:#5b7a70;font-size:11px}.sp-settings-leave-dates span{margin-left:4px}.sp-settings-leave-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:#8a9a9f}.sp-settings-leave-summary small{font-size:11px}.sp-settings-link{border:0;background:none;color:#245b4e;padding:4px;font-size:12px!important}.sp-settings-form-footer{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-top:21px;margin-top:22px;border-top:1px solid #edf1f2}.sp-settings-form-footer p{font-size:12px;color:#8b9ca2;line-height:1.7}.sp-settings-employee-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.sp-settings-employee-card,.sp-settings-shift-card{background:#fff;border:1px solid #e3e9ec;border-radius:14px;padding:20px;min-width:0;box-shadow:0 2px 3px #1a3a4002}.sp-settings-person,.sp-settings-shift-top{display:flex;align-items:center;gap:12px}.sp-settings-person>div,.sp-settings-shift-top>div{min-width:0}.sp-settings-person h3{overflow-wrap:anywhere}.sp-settings-person p,.sp-settings-shift-top p{font-size:11px;color:#94a1a8;margin-top:5px;line-height:1.6}.sp-settings-edit{margin-left:auto;background:none;border:0;color:#63958d;font-size:12px!important;padding:6px 0 6px 8px;flex-shrink:0}.sp-settings-edit:hover{color:#245b4e}.sp-settings-badges{display:flex;flex-wrap:wrap;gap:6px;margin:19px 0 18px;min-height:23px}.sp-settings-badges>span{font-size:11px;padding:5px 10px;border-radius:5px;color:#4c6669;background:#eff3f4;line-height:1}.sp-settings-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid #f0f3f4;padding-top:14px;font-size:11px;color:#87979e;line-height:1.5}.sp-settings-remove{background:none;border:0;color:#b4bec2;padding:4px 0 4px 8px;font-size:11px!important}.sp-settings-remove:hover:not(:disabled){color:#c36959}.sp-settings-empty{padding:60px 20px;text-align:center;color:#648077;background:#fff;border:1px dashed #d9e3e5;border-radius:14px}.sp-settings-empty p{font-size:13px;margin-top:12px;color:#91a1a7}.sp-settings-colors{display:flex;align-items:center;gap:8px;min-height:40px;flex-wrap:wrap}.sp-settings-colors>button{width:27px;height:27px;border-radius:50%;border:2px solid transparent;color:#446960;padding:0;flex-shrink:0}.sp-settings-colors>button.active{box-shadow:0 0 0 2px #fff,0 0 0 3px #245b4e}.sp-settings-custom-color input{width:30px;height:30px;min-height:0;padding:2px;cursor:pointer;border-radius:50%}.sp-settings-soft-note{background:#edf6f3;border:1px solid #dcece6;border-radius:10px;padding:14px 17px;font-size:12px;color:#5d7c72;line-height:1.8;margin-top:20px!important}.sp-settings-soft-note p{margin-top:6px}.sp-settings-shift-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.sp-settings-shift-mark{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:650;flex-shrink:0}.sp-settings-shift-time{font-size:28px;color:#314b54;font-weight:600;margin:24px 0;letter-spacing:-.7px;white-space:nowrap}.sp-settings-shift-time>span{font-size:20px;color:#b6c3c7;margin:0 8px}.sp-settings-shift-time>small{font-size:10px;color:#8a9a9f;font-weight:400;vertical-align:top;letter-spacing:0;margin-left:5px}.sp-settings-footnote{font-size:12px;color:#8e9da4;margin-top:22px!important;line-height:1.8}.sp-settings-rule{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:25px 0;border-bottom:1px solid #edf1f2}.sp-settings-rule:first-child{padding-top:2px}.sp-settings-rule:nth-child(3){border-bottom:0}.sp-settings-rule>div{position:relative;padding-left:42px;flex:1}.sp-settings-rule-number{position:absolute;left:0;top:0;background:#eaf5f1;color:#68998c;border-radius:8px;padding:7px;font-size:11px}.sp-settings-rule h3{padding-top:5px}.sp-settings-rule p{font-size:12px;color:#8b9aa1;line-height:1.8;margin-top:8px}.sp-settings-rule>.sp-settings-input-unit{width:120px;flex-shrink:0}.sp-settings-switch{display:flex;align-items:center;gap:9px;position:relative;cursor:pointer;flex-shrink:0}.sp-settings-switch input{position:absolute;left:0;top:0;opacity:0;width:40px;height:23px}.sp-settings-switch>span{pointer-events:none;width:40px;height:23px;background:#d4dee1;border-radius:20px;position:relative;transition:background .2s}.sp-settings-switch>span:after{content:'';position:absolute;width:17px;height:17px;top:3px;left:3px;border-radius:50%;background:white;box-shadow:0 1px 3px #133e4229;transition:transform .2s}.sp-settings-switch input:checked+span{background:#245b4e}.sp-settings-switch input:checked+span:after{transform:translateX(17px)}.sp-settings-switch input:focus-visible+span{outline:3px solid #99ddd4;outline-offset:3px}.sp-settings-switch small{font-size:11px;color:#8b9da3}.sp-settings-explanation{display:flex;align-items:flex-start;gap:17px;padding:22px 24px;background:#eef4f7;border:1px solid #dfe9ee;border-radius:14px;color:#668293}.sp-settings-explanation svg{width:26px;height:26px;stroke:#7a9ba7;fill:none;stroke-width:1.5;flex-shrink:0}.sp-settings-explanation h3{font-size:13px}.sp-settings-explanation p{font-size:12px;line-height:1.9;margin-top:8px}.sp-settings-label{font-size:10px;color:#8e9fa6;background:#f2f6f6;padding:5px 8px;border-radius:5px;white-space:nowrap}.sp-settings-full-field{grid-column:1/-1}.sp-settings input[type=number]{appearance:textfield}.sp-settings input[type=number]::-webkit-inner-spin-button{opacity:.4}
.sp-settings-separation>.sp-settings-card-heading{align-items:flex-start}.sp-settings-separation>.sp-settings-card-heading p{line-height:1.8}.sp-settings-separation-editor{padding:20px;border:1px solid #c9e3dc;background:#f8fcfa;border-radius:12px;margin-bottom:18px}.sp-settings-selection-count{margin-left:12px;font-weight:400;color:#245b4e}.sp-settings-member-options{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:285px;overflow:auto;padding:2px}.sp-settings-member-option{padding:10px 12px;background:#fff;border:1px solid #e0e8e6;border-radius:8px;min-width:0;align-items:flex-start;cursor:pointer}.sp-settings-member-option.selected{border-color:#89caba;background:#edf8f3}.sp-settings-member-option input{margin-top:2px}.sp-settings-member-option>span{overflow-wrap:anywhere}.sp-settings-member-option small{display:block!important;margin-top:3px;line-height:1.5}.sp-settings-specific-shifts{padding:15px 0 0}.sp-settings-separation-list{display:grid;gap:12px}.sp-settings-separation-group{border:1px solid #e2eae7;border-radius:10px;padding:16px 18px;background:#fcfefd;min-width:0}.sp-settings-separation-title{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.sp-settings-separation-title h3{overflow-wrap:anywhere}.sp-settings-separation-title>.sp-settings-actions{margin-left:auto}.sp-settings-separation-names{font-size:13px;color:#50756c;margin-top:12px!important;line-height:1.8;overflow-wrap:anywhere}.sp-settings-separation-scope{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11px;color:#8b9b98;margin-top:9px!important;line-height:1.7}.sp-settings-separation-scope>span{color:#68a493}
@media(max-width:720px){.sp-settings-separation>.sp-settings-card-heading{flex-wrap:wrap}.sp-settings-separation-editor{padding:15px}.sp-settings-member-options{grid-template-columns:repeat(2,minmax(0,1fr))}.sp-settings-member-option{padding:10px 8px}.sp-settings-selection-count{display:block;margin:7px 0 0}.sp-settings-separation-group{padding:15px}.sp-settings-separation-title{gap:8px}.sp-settings-separation-title .sp-settings-actions{gap:6px}}
@media(min-width:1500px){.sp-settings-employee-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:1100px){.sp-settings-employee-grid,.sp-settings-shift-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sp-settings-config-card{padding:20px}}
@media(max-width:720px){.sp-settings-heading{align-items:flex-start;margin-bottom:20px;gap:15px}.sp-settings h2{font-size:19px}.sp-settings-heading p{font-size:12px}.sp-settings-heading>.sp-settings-button{padding:9px 12px;font-size:12px!important}.sp-settings-employee-grid,.sp-settings-shift-grid{grid-template-columns:1fr}.sp-settings-employee-card,.sp-settings-shift-card{padding:18px}.sp-settings-editor,.sp-settings-config-card{padding:18px}.sp-settings-toolbar{flex-wrap:wrap}.sp-settings-toolbar>span{font-size:11px}.sp-settings-form-grid{gap:15px}.sp-settings-confirm,.sp-settings-form-footer{flex-wrap:wrap}.sp-settings-form-footer>.sp-settings-actions{margin-left:auto}.sp-settings-leave-row{flex-wrap:wrap;gap:10px}.sp-settings-leave-row>.sp-settings-field{min-width:120px}.sp-settings-leave-row>.sp-settings-button{width:100%}.sp-settings-choice-row{gap:14px}.sp-settings-checkbox small{display:none}.sp-settings-rule{gap:12px}.sp-settings-rule>div{padding-left:0}.sp-settings-rule-number{position:static;display:inline-block;margin-bottom:7px}.sp-settings-rule>.sp-settings-input-unit{width:90px}.sp-settings-rule h3{font-size:14px}.sp-settings-switch small{display:none}.sp-settings-explanation{padding:18px}.sp-settings-shift-time{font-size:30px}.sp-settings-card-heading{gap:10px}.sp-settings-card-heading h3{font-size:14px}.sp-settings-field{font-size:11px}.sp-settings-field input,.sp-settings-input-unit input{font-size:16px}.sp-settings-input-unit>span{font-size:11px}}
.sp-settings input[type=number]{appearance:textfield;-moz-appearance:textfield}
.sp-settings input[type=number]::-webkit-inner-spin-button,.sp-settings input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
@media(max-width:720px){.sp-settings-rule>.sp-settings-input-unit{width:110px;min-width:110px;flex:0 0 110px}.sp-settings-rule>.sp-settings-input-unit input{padding:10px 10px}}
.sp-settings-weekday-rule>.sp-settings-rule{padding:24px 0 16px;border-bottom:0}.sp-settings-weight-options{margin-left:42px}.sp-settings-weight-days{margin-top:0}.sp-settings-weekday-options{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;max-width:680px}.sp-settings-weekday-option{display:flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:8px;border:1px solid #dfe8e6;border-radius:8px;background:#fbfdfc;color:#637b80;font-size:12px;cursor:pointer}.sp-settings-weekday-option.selected{border-color:#8fc8b9;background:#edf7f2;color:#245b4e}.sp-settings-weekday-option input{accent-color:#245b4e;width:15px;height:15px;flex-shrink:0;margin:0}.sp-settings-weight-percent-row{display:flex;align-items:center;gap:20px;margin-top:20px}.sp-settings-weight-percent-row>.sp-settings-field{width:180px;flex-shrink:0}.sp-settings-weight-percent-row>.sp-settings-hint{max-width:480px;margin-top:0!important}.sp-settings-weight-formula{padding:14px 16px;margin-top:18px;border-radius:8px;background:#f2f7f5;color:#416d60}.sp-settings-weight-formula strong{font-size:13px}.sp-settings-weight-formula p{font-size:12px;margin-top:7px;line-height:1.8}.sp-settings-weight-capacity{padding:14px 0 0;color:#658079;line-height:1.8}.sp-settings-weight-capacity strong{font-size:12px;font-weight:600}.sp-settings-weight-capacity p{font-size:11px;margin-top:5px}.sp-settings-weight-capacity-warning{color:#9a682c}.sp-settings-weight-preview{margin-top:22px}.sp-settings-weight-preview-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.sp-settings-weight-preview-heading h4{font-size:13px;font-weight:600;margin:0;color:#496771}.sp-settings-weight-preview-heading>span{font-size:12px;color:#748a92}.sp-settings-weight-month-total{color:#245b4e;font-variant-numeric:tabular-nums}.sp-settings-weight-weeks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.sp-settings-weight-week{padding:14px;border:1px solid #e0e9e7;border-radius:10px;background:#fcfefd;min-width:0}.sp-settings-weight-week>header{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.sp-settings-weight-week>header>strong{font-size:12px;color:#53726b}.sp-settings-weight-week>header>span{font-size:10px;color:#879c95}.sp-settings-weight-week>dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:17px 0 0}.sp-settings-weight-week dt{font-size:10px;color:#8c9c9e}.sp-settings-weight-week dd{margin:7px 0 0;font-size:10px;color:#879b94}.sp-settings-weight-week dd strong{font-size:19px;font-weight:600;color:#476d60;font-variant-numeric:tabular-nums}.sp-settings-weight-week details{margin-top:14px;padding-top:11px;border-top:1px solid #eaf0ed;font-size:11px;color:#819790}.sp-settings-weight-week summary{cursor:pointer;padding:3px 0;line-height:1.6;color:#608476}.sp-settings-weight-week summary:focus-visible{outline:3px solid #99ddd4;outline-offset:3px}.sp-settings-weight-week ul{padding:0;margin:10px 0;list-style:none;display:grid;gap:7px}.sp-settings-weight-week li{display:flex;justify-content:space-between;gap:8px}.sp-settings-weight-week li.selected{color:#245b4e}.sp-settings-weight-week li strong{font-weight:500}.sp-settings-weight-week details p{font-size:10px;line-height:1.8}.sp-settings-weight-options>.sp-settings-soft-note{margin-top:18px!important}
@media(max-width:720px){.sp-settings-weight-options{margin-left:0}.sp-settings-weekday-options{grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.sp-settings-weekday-option{padding:8px 5px;gap:6px}.sp-settings-weight-percent-row{align-items:flex-start;flex-wrap:wrap;gap:10px}.sp-settings-weight-percent-row>.sp-settings-field{width:100%}.sp-settings-weight-percent-row>.sp-settings-hint{width:100%}.sp-settings-weight-weeks{grid-template-columns:1fr}.sp-settings-weight-week{padding:14px}.sp-settings-weekday-rule>.sp-settings-rule{padding-top:20px}.sp-settings-weight-options>.sp-settings-soft-note{padding:12px;line-height:1.85}}
@media(prefers-reduced-motion:reduce){.sp-settings button,.sp-settings-switch>span,.sp-settings-switch>span:after{transition:none}}
.sp-settings-shift-allowance{margin:-8px 0 20px!important;font-size:12px;color:#81908f;line-height:1.8}.sp-settings-shift-allowance strong{color:#966c23;margin-left:8px;font-weight:600}.sp-settings-shift-allowance>span{font-size:11px}

.sp-settings-inline-guide{font-size:12px;color:#788d88;line-height:1.85;margin:0 0 18px!important}.sp-settings-inline-hours{margin-top:20px}.sp-settings-inline-shifts{border:0;padding:0;margin:0 0 18px;min-width:0}.sp-settings-inline-shifts legend{font-size:11px;font-weight:600;color:#6b8278;margin-bottom:10px}.sp-settings-inline-shift-options{display:flex;flex-wrap:wrap;gap:6px}.sp-settings-inline-shift-options>button{display:inline-flex;align-items:center;gap:5px;border:1px solid #dce7e1;border-radius:6px;background:#f8fbf9;color:#809389;font-size:11px;padding:7px 9px;min-height:34px;max-width:100%;overflow-wrap:anywhere;text-align:left}.sp-settings-inline-shift-options>button.selected{background:var(--shift-color);border-color:#a8c5b8;color:#3f6c58}.sp-settings-inline-shift-options>button>span{font-size:12px;flex-shrink:0}.sp-settings-inline-hint{font-size:10px;line-height:1.8;color:#8a9a91;margin-top:8px!important}.sp-settings-inline-month{padding-top:15px;border-top:1px solid #edf1ee}.sp-settings-inline-reference{font-size:11px;line-height:1.6;margin-bottom:13px}.sp-settings-inline-reference input{width:15px;height:15px}.sp-settings-inline-hours .sp-settings-field{font-size:11px;gap:7px}.sp-settings-inline-hours .sp-settings-input-unit{min-height:38px;padding-right:9px}.sp-settings-inline-hours .sp-settings-input-unit input{padding:9px 10px;font-size:13px}.sp-settings-inline-hours input:disabled{color:#8f9f98;background:#f0f5f2;cursor:default}.sp-settings-inline-hours .sp-settings-input-unit>span{font-size:10px}.sp-settings-inline-week{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:13px}.sp-settings-inline-error{font-size:11px;line-height:1.75;color:#ab5745;background:#fff3ee;border:1px solid #f2d9cc;border-radius:6px;padding:9px 10px;margin-top:12px!important}.sp-settings-inline-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:14px;padding-top:12px;border-top:1px dashed #dce6df}.sp-settings-inline-actions>span{font-size:10px;color:#967549}.sp-settings-inline-actions>div{display:flex;gap:6px;margin-left:auto}.sp-settings-inline-actions .sp-settings-button{padding:7px 10px;font-size:11px!important;min-height:34px}.sp-settings-member-bottom{margin-top:18px}.sp-settings-leave-trigger{display:inline-flex;align-items:center;gap:7px;border:0;padding:5px 0;background:none;color:#5c8a74;font-size:11px!important;min-height:30px;text-align:left}.sp-settings-leave-trigger svg{width:16px;height:16px;stroke:currentColor;stroke-width:1.6;fill:none;flex-shrink:0}.sp-settings-leave-trigger:hover{color:#245b4e}
@media(max-width:720px){.sp-settings-inline-hours .sp-settings-input-unit input{font-size:16px}.sp-settings-inline-hours{margin-top:18px}.sp-settings-inline-shift-options>button{min-height:38px;padding:8px 10px}.sp-settings-inline-actions .sp-settings-button{min-height:38px}.sp-settings-leave-trigger{min-height:36px;font-size:12px!important}.sp-settings-inline-guide{font-size:11px}.sp-settings-inline-week{gap:12px}}
.sp-settings-weight-example-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}.sp-settings-weight-example-heading>div{flex:1;min-width:180px}.sp-settings-weight-example-heading>.sp-settings-field{width:185px;flex-shrink:0}.sp-settings-weight-example-heading>.sp-settings-field input{font-variant-numeric:tabular-nums}@media(max-width:720px){.sp-settings-weight-example-heading{gap:13px}.sp-settings-weight-example-heading>.sp-settings-field{width:100%}}
.sp-settings-staffing-mode{grid-column:1/-1;border:0;padding:0;margin:0;min-width:0}.sp-settings-staffing-mode legend{font-size:12px;color:#657982;font-weight:600;margin-bottom:10px}.sp-settings-staffing-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sp-settings-staffing-options>label{display:flex;align-items:flex-start;gap:10px;padding:13px 14px;border:1px solid #dfe8e4;border-radius:9px;background:#fbfdfc;color:#728a80;cursor:pointer;min-width:0}.sp-settings-staffing-options>label.selected{border-color:#83b5a2;background:#edf6f1;color:#2c654e}.sp-settings-staffing-options input{accent-color:#245b4e;width:16px;height:16px;flex-shrink:0;margin:1px 0 0}.sp-settings-staffing-options strong{display:block;font-size:12px;font-weight:600;line-height:1.5}.sp-settings-staffing-options small{display:block;margin-top:5px;font-size:11px;line-height:1.7;color:#83998f}.sp-settings-staffing-options>label:focus-within{outline:3px solid #99ddd4;outline-offset:2px}@media(max-width:720px){.sp-settings-staffing-options{gap:8px}.sp-settings-staffing-options>label{padding:12px 9px;gap:7px}.sp-settings-staffing-options strong{font-size:11px}.sp-settings-staffing-options small{font-size:10px}.sp-settings-staffing-mode legend{font-size:11px}}
.sp-settings-current-month{display:flex;flex-direction:column;gap:5px;flex-shrink:0;padding:9px 12px;border-radius:7px;background:#f1f7f3;color:#56776b;line-height:1.5;margin:0!important}.sp-settings-current-month strong{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}.sp-settings-current-month>span{font-size:10px;color:#8ba095}@media(max-width:720px){.sp-settings-current-month{flex-basis:100%;flex-direction:row;justify-content:space-between;align-items:center;padding:9px 10px}}
.sp-settings-month-reference{padding:18px 20px}.sp-settings-month-reference>.sp-settings-reference-body{margin-top:0;align-items:center;gap:20px}.sp-settings-reference-summary h3{font-size:13px;font-weight:600;margin-bottom:7px}.sp-settings-reference-summary h3 small{font-size:11px;font-weight:400;color:#95a49e;margin-left:9px}.sp-settings-month-reference .sp-settings-reference-summary strong{font-size:28px}.sp-settings-month-reference .sp-settings-reference-summary p{font-size:11px;margin-top:5px}.sp-settings-month-reference .sp-settings-reference-form>.sp-settings-field{width:155px}.sp-settings-month-reference .sp-settings-reference-form{gap:10px}.sp-settings-month-reference .sp-settings-calendar-warning{font-size:11px;padding:8px 10px;margin-top:12px!important}.sp-settings-help-details{font-size:11px;line-height:1.85;color:#809389;margin-top:14px;padding-top:12px;border-top:1px solid #e7ede8}.sp-settings-help-details>summary{cursor:pointer;color:#587d6c;font-size:12px;line-height:1.6;padding:4px 0;min-height:27px;width:fit-content;max-width:100%}.sp-settings-help-details>summary:focus-visible{outline:3px solid #99ddd4;outline-offset:3px;border-radius:3px}.sp-settings-help-details>p{margin-top:10px!important;font-size:11px;line-height:1.9}.sp-settings-help-details>.sp-settings-soft-note{margin-top:10px!important;padding:12px 14px;background:#f8fbf9;border-color:#e5eee8}.sp-settings-reference-details{margin-top:13px;padding-top:9px}.sp-settings-calculation-details{margin-top:16px}.sp-settings-calculation-details>.sp-settings-weight-formula{margin-top:13px}.sp-settings-bottom-help{padding:0;border:0;margin-top:15px}.sp-settings-bottom-help .sp-settings-footnote{margin-top:8px!important}@media(max-width:720px){.sp-settings-month-reference{padding:15px}.sp-settings-month-reference>.sp-settings-reference-body{gap:13px}.sp-settings-month-reference .sp-settings-reference-summary{flex-basis:100%}.sp-settings-reference-form>.sp-settings-field{flex-basis:100%!important}.sp-settings-reference-form>.sp-settings-actions{width:100%}.sp-settings-reference-form>.sp-settings-actions>.sp-settings-button{flex:1}.sp-settings-reference-details{margin-top:12px}.sp-settings-help-details>summary{min-height:32px}.sp-settings-help-details>.sp-settings-soft-note{padding:11px}}
.sp-settings-editor,.sp-settings-separation-editor{scroll-margin-top:110px}@media(max-width:720px){.sp-settings-editor,.sp-settings-separation-editor{scroll-margin-top:150px}}
.sp-settings-rule-tabs{display:flex;gap:4px;padding:4px;background:#eaf0ec;border:1px solid #e0e8e2;border-radius:10px;width:fit-content;max-width:100%;margin-bottom:16px}.sp-settings-rule-tabs>button{border:1px solid transparent;border-radius:7px;min-height:42px;padding:10px 25px;background:transparent;color:#72897d;font-size:13px!important;font-weight:600;cursor:pointer}.sp-settings-rule-tabs>button[aria-selected=true]{background:#fff;color:#285e4f;border-color:#dce6df}.sp-settings-rule-tabs>button:hover{color:#285e4f}.sp-settings-rule-tabs>button:focus-visible{outline:3px solid #99ddd4;outline-offset:2px}.sp-settings-rule-category-note{font-size:12px;line-height:1.8;color:#7e9387;margin:0 0 18px!important}.sp-settings-rule-panel{min-width:0;scroll-margin-top:110px}.sp-settings-rule-panel:focus-visible{outline:3px solid #99ddd4;outline-offset:5px;border-radius:8px}@media(max-width:720px){.sp-settings-rule-tabs{width:100%}.sp-settings-rule-tabs>button{flex:1;min-height:44px;padding:10px 12px}.sp-settings-rule-category-note{font-size:11px;margin-bottom:15px!important}.sp-settings-rule-panel{scroll-margin-top:150px}}
.sp-settings-staffing-summary{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}.sp-settings-staffing-badge{display:inline-flex;align-items:center;gap:4px;padding:7px 9px;border:1px solid #c8e2d2;border-radius:6px;background:#edf7f0;color:#28644c;font-size:12px;font-weight:600;line-height:1.5;max-width:100%;flex-wrap:wrap}.sp-settings-staffing-badge.is-fixed{background:#edf4fc;border-color:#cdddf0;color:#3c6191}.sp-settings-staffing-badge strong{font-size:13px;font-variant-numeric:tabular-nums}.sp-settings-staffing-summary>small{font-size:10px;line-height:1.6;color:#81958a}.sp-settings-shift-card>.sp-settings-card-bottom>.sp-settings-remove{flex-shrink:0;min-height:36px}@media(max-width:720px){.sp-settings-staffing-badge{font-size:12px;padding:7px 9px}.sp-settings-shift-card>.sp-settings-card-bottom>.sp-settings-remove{min-height:44px}}
.sp-settings-auto-status{font-size:11px;color:#6d8b78;line-height:1.6;margin:8px 0 0!important;min-height:18px}.sp-settings-config-card,.sp-settings-editor{padding:18px;margin-bottom:16px}.sp-settings-employee-card,.sp-settings-shift-card{padding:16px}.sp-settings-employee-grid,.sp-settings-shift-grid{gap:14px}.sp-settings-card-heading{margin-bottom:16px}.sp-settings-form-grid{gap:15px}.sp-settings-inline-hours{margin-top:14px}.sp-settings-inline-shifts{margin-bottom:13px}.sp-settings-inline-shifts legend{margin-bottom:8px}.sp-settings-inline-month{padding-top:12px}.sp-settings-inline-week{margin-top:11px}.sp-settings-inline-hours .sp-settings-input-unit{min-height:40px}.sp-settings-inline-shift-options>button{min-height:40px}.sp-settings-member-bottom{margin-top:12px}.sp-settings-person{gap:10px}.sp-settings-person .sp-settings-edit,.sp-settings-shift-top .sp-settings-edit{min-height:40px;min-width:40px}.sp-settings-member-bottom .sp-settings-remove,.sp-settings-leave-trigger{min-height:40px}.sp-settings-rule{padding:18px 0;gap:20px}.sp-settings-form-footer{padding-top:16px;margin-top:16px}.sp-settings-separation-editor{padding:16px;margin-bottom:14px}.sp-settings-separation-group{padding:14px}.sp-settings-shift-time{margin:20px 0}.sp-settings-shift-allowance{margin-bottom:16px!important}.sp-settings-month-reference{padding:16px 18px}.sp-settings-inline-error{margin-top:9px!important}@media(max-width:720px){.sp-settings-config-card,.sp-settings-editor{padding:15px;margin-bottom:14px}.sp-settings-employee-card,.sp-settings-shift-card{padding:15px}.sp-settings-employee-grid,.sp-settings-shift-grid{gap:12px}.sp-settings-inline-hours{margin-top:12px}.sp-settings-inline-shift-options>button,.sp-settings-person .sp-settings-edit,.sp-settings-shift-top .sp-settings-edit,.sp-settings-member-bottom .sp-settings-remove,.sp-settings-leave-trigger{min-height:44px}.sp-settings-inline-hours .sp-settings-input-unit,.sp-settings-inline-hours .sp-settings-input-unit input{min-height:44px}.sp-settings-button{min-height:44px}.sp-settings-rule{padding:16px 0;gap:14px}.sp-settings-form-footer{padding-top:14px;margin-top:14px}.sp-settings-month-reference{padding:15px}.sp-settings-rule-tabs{margin-bottom:13px}}

</style>
