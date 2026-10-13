<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Employee, PlannerState, Rules, Shift } from './domain.ts'
import type { PayrollSettings } from './payroll.ts'
import type { DayKind } from './calendar.ts'
import { hoursToMinutes, minimumMonthHours, monthlyHoursReference } from './hours.ts'
import { weightedDayRange, weightedWeeks, weekdayWeightCapacity, weekdayWeightRuleError } from './weekday-weights.ts'
import type { WeightedWeek } from './weekday-weights.ts'

const props = defineProps<{ state: PlannerState; section: 'team' | 'shifts' | 'rules' | 'payroll'; payroll: PayrollSettings; calendar?: Record<string, DayKind> }>()
const emit = defineEmits<{ change: [] }>()
// Keep these form limits aligned with storage.ts so every saved form can be backed up.
const limits = { employees: 200, shifts: 24, separationGroups: 200, monthlyReferences: 1200, leaveDates: 3660, employeeText: 80, shiftName: 60, shortName: 8, groupName: 80, required: 200, minRestHours: 48, allowance: 100000000 }
const feedback = ref('')
const error = ref('')
const editor = ref<'employee' | 'shift' | 'separation' | null>(null)
const allowanceShiftId = ref('')
const allowanceDraft = ref<number | string>(0)
const pendingDelete = ref<{ type: 'employee' | 'shift' | 'separation'; id: string; name: string } | null>(null)
const leaveStart = ref('')
const leaveEnd = ref('')
const employeeDraft = reactive<Employee>({ id: '', name: '', role: '', group: '', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: [], unavailableDates: [] })
const followMonthlyReference = ref(true)
const employeeMonthHours = ref<number | string>(0)
const monthReference = computed(() => monthlyHoursReference(props.state))
const referenceDraft = ref<number | string>(monthReference.value.hours)
watch([() => props.state.month, () => monthReference.value.hours, () => monthReference.value.custom], () => {
  referenceDraft.value = monthReference.value.hours
})
const shiftDraft = reactive<Shift>({ id: '', name: '', shortName: '', start: '08:00', end: '16:00', color: '#dbeee6', required: 1, normalAllowance: 0 })
const rulesDraft = reactive<Rules>({ ...props.state.rules })
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
const weekdayPreviewWeeks = computed(() => weightedWeeks(weekdayPreviewState.value))
const weekdayCapacity = computed(() => weekdayWeightCapacity(weekdayPreviewState.value))
const weekdayBaseline = computed(() => props.state.shifts.reduce((sum, shift) => sum + shift.required, 0) * 7)
const weekdayFullSelected = computed(() => Math.ceil(weekdayBaseline.value * Number(weekdayPercent.value) / 100))
const weekdaySelectedLabel = computed(() => weekdayOptions.filter(day => weekdayDays.value.includes(day.value)).map(day => day.short).join('、'))
const weekdayMonthlyTotal = computed(() => weekdayPreviewWeeks.value.reduce((sum, week) => sum + week.totalTarget, 0))
function resetRules() {
  Object.assign(rulesDraft, props.state.rules)
  weekdayWeightsEnabled.value = !!props.state.rules.weekdayWeights
  weekdayDays.value = [...(props.state.rules.weekdayWeights?.days ?? [1, 6])]
  weekdayPercent.value = props.state.rules.weekdayWeights?.percent ?? 40
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
const displayedEmployees = computed(() => props.state.employees.filter(employee => `${employee.name} ${employee.role} ${employee.group}`.includes(employeeSearch.value.trim())))
const colors = ['#dbeee6', '#e5def7', '#dce8fa', '#f8e5cc', '#f7dbdf', '#dceced', '#ebe6df']
const shiftDuration = computed(() => {
  const parse = (time: string) => { const [h = 0, m = 0] = time.split(':').map(Number); return h * 60 + m }
  const minutes = (parse(shiftDraft.end) - parse(shiftDraft.start) + 1440) % 1440
  return Number((minutes / 60).toFixed(2))
})
watch([() => props.section, () => props.state, () => props.payroll], () => {
  editor.value = null; allowanceShiftId.value = ''; pendingDelete.value = null; feedback.value = ''; error.value = ''
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
function changeReferenceMonth(event: Event) {
  const input = event.target as HTMLInputElement
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.value) || Number(input.value.slice(0, 4)) < 1) {
    input.value = props.state.month; error.value = '请选择有效的月份，年份为 0001–9999。'; return
  }
  props.state.month = input.value
  error.value = ''; feedback.value = ''; emit('change')
}
function saveReferenceHours() {
  if (!validHours(referenceDraft.value, 744, '月参考工时')) return
  const overrides = props.state.monthlyReferenceHours ?? {}
  if (!Object.hasOwn(overrides, props.state.month) && Object.keys(overrides).length >= limits.monthlyReferences) { error.value = `最多保存 ${limits.monthlyReferences} 个月的手动参考值，请先选择不再使用的月份并恢复自动计算。`; return }
  props.state.monthlyReferenceHours = { ...props.state.monthlyReferenceHours, [props.state.month]: Number(referenceDraft.value) }
  notice(`${props.state.month} 月参考工时已保存。跟随参考值的成员会同步更新，个人自定义值保持不变。`)
}
function resetReferenceHours() {
  const overrides = { ...props.state.monthlyReferenceHours }
  delete overrides[props.state.month]
  props.state.monthlyReferenceHours = overrides
  notice(`${props.state.month} 已恢复按月工作日 × 8 小时计算参考工时。`)
}
function openEmployee(employee?: Employee) {
  if (!employee && props.state.employees.length >= limits.employees) { error.value = `最多支持 ${limits.employees} 位员工，请先删除不再使用的人员。`; return }
  Object.assign(employeeDraft, employee ? { ...employee, minHoursPerMonth: employee.minHoursPerMonth ?? null, minHoursPerWeek: employee.minHoursPerWeek ?? 0, eligibleShiftIds: [...employee.eligibleShiftIds], unavailableDates: [...employee.unavailableDates] } : { id: '', name: '', role: '', group: '', color: '#d7e8f8', minHoursPerMonth: null, minHoursPerWeek: 0, maxHoursPerWeek: 40, eligibleShiftIds: props.state.shifts.map(shift => shift.id), unavailableDates: [] })
  followMonthlyReference.value = employeeDraft.minHoursPerMonth == null
  employeeMonthHours.value = employeeDraft.minHoursPerMonth ?? monthReference.value.hours
  leaveStart.value = `${props.state.month}-01`; leaveEnd.value = `${props.state.month}-01`
  editor.value = 'employee'; error.value = ''; feedback.value = ''; pendingDelete.value = null
}
function addLeave() {
  const start = Date.parse(`${leaveStart.value}T00:00:00Z`), end = Date.parse(`${leaveEnd.value}T00:00:00Z`)
  if (!validDate(leaveStart.value) || !validDate(leaveEnd.value) || end < start) { error.value = '请选择有效的请假起止日期，年份为 0001–9999，结束日不能早于开始日。'; return }
  if ((end - start) / 86400000 >= limits.leaveDates) { error.value = `每位员工最多设置 ${limits.leaveDates} 天请假，请缩短区间。`; return }
  const dates = new Set(employeeDraft.unavailableDates)
  for (let day = start; day <= end; day += 86400000) dates.add(new Date(day).toISOString().slice(0, 10))
  if (dates.size > limits.leaveDates) { error.value = `每位员工累计最多设置 ${limits.leaveDates} 天请假，请先移除不再需要的日期。`; return }
  employeeDraft.unavailableDates = [...dates].sort(); error.value = ''
}
function saveEmployee() {
  if (!employeeDraft.id && props.state.employees.length >= limits.employees) { error.value = `最多支持 ${limits.employees} 位员工。`; return }
  if (!validText(employeeDraft.name, limits.employeeText, '员工姓名') || !validText(employeeDraft.role, limits.employeeText, '岗位', true) || !validText(employeeDraft.group, limits.employeeText, '分组', true)) return
  if (employeeDraft.unavailableDates.length > limits.leaveDates || employeeDraft.unavailableDates.some(date => !validDate(date))) { error.value = `请假日期需为有效日期，且最多 ${limits.leaveDates} 天。`; return }
  if (props.state.employees.some(employee => employee.id !== employeeDraft.id && employee.name === employeeDraft.name.trim())) { error.value = '已有同名员工，请在姓名后增加标识以便区分。'; return }
  if (!followMonthlyReference.value && !validHours(employeeMonthHours.value, 744, '每月最低工时')) return
  if (!validHours(employeeDraft.minHoursPerWeek, 168, '每周最低工时') || !validHours(employeeDraft.maxHoursPerWeek, 168, '每周最高工时')) return
  const minimumWeekHours = Number(employeeDraft.minHoursPerWeek), maximumWeekHours = Number(employeeDraft.maxHoursPerWeek)
  if (minimumWeekHours > maximumWeekHours || hoursToMinutes(minimumWeekHours, 'ceil') > hoursToMinutes(maximumWeekHours, 'floor')) { error.value = '每周最低工时不能高于每周最高工时；排班精确到分钟，最低向上、最高向下取整。'; return }
  const employee: Employee = { ...employeeDraft, id: employeeDraft.id || `employee-${crypto.randomUUID()}`, name: employeeDraft.name.trim(), role: employeeDraft.role.trim(), group: employeeDraft.group.trim(), minHoursPerMonth: followMonthlyReference.value ? null : Number(employeeMonthHours.value), minHoursPerWeek: Number(employeeDraft.minHoursPerWeek), maxHoursPerWeek: Number(employeeDraft.maxHoursPerWeek), eligibleShiftIds: [...employeeDraft.eligibleShiftIds], unavailableDates: [...employeeDraft.unavailableDates] }
  const existing = props.state.employees.findIndex(item => item.id === employee.id)
  if (existing >= 0) props.state.employees.splice(existing, 1, employee)
  else props.state.employees.push(employee)
  editor.value = null; notice('人员设置已保存。请回到排班日历检查冲突，或重新生成排班。')
}
function openShift(shift?: Shift) {
  if (!shift && props.state.shifts.length >= limits.shifts) { error.value = `最多支持 ${limits.shifts} 个班次，请先删除不再使用的班次。`; return }
  Object.assign(shiftDraft, shift ? { ...shift, normalAllowance: shift.normalAllowance ?? 0 } : { id: '', name: '', shortName: '', start: '08:00', end: '16:00', color: colors[props.state.shifts.length % colors.length], required: 1, normalAllowance: 0 })
  editor.value = 'shift'; error.value = ''; feedback.value = ''; pendingDelete.value = null
}
function saveShift() {
  if (!shiftDraft.id && props.state.shifts.length >= limits.shifts) { error.value = `最多支持 ${limits.shifts} 个班次。`; return }
  if (!validText(shiftDraft.name, limits.shiftName, '班次名称') || !validText(shiftDraft.shortName, limits.shortName, '日历简称')) return
  if (props.state.shifts.some(shift => shift.id !== shiftDraft.id && shift.name === shiftDraft.name.trim())) { error.value = '班次名称已存在，请使用不同名称。'; return }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftDraft.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftDraft.end) || shiftDraft.start === shiftDraft.end) { error.value = '请填写有效的起止时间，开始和结束不能相同。'; return }
  if (!Number.isInteger(Number(shiftDraft.required)) || Number(shiftDraft.required) < 0 || Number(shiftDraft.required) > limits.required) { error.value = `每日需求人数需要为 0–${limits.required} 的整数。`; return }
  const allowance = shiftDraft.normalAllowance
  if (!validAllowance(allowance)) return
  if (!/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/.test(shiftDraft.color)) { error.value = '请选择有效的班次颜色。'; return }
  const shift: Shift = { ...shiftDraft, id: shiftDraft.id || `shift-${crypto.randomUUID()}`, name: shiftDraft.name.trim(), shortName: shiftDraft.shortName.trim(), required: Number(shiftDraft.required), normalAllowance: Number(allowance) }
  const existing = props.state.shifts.findIndex(item => item.id === shift.id)
  if (existing >= 0) props.state.shifts.splice(existing, 1, shift)
  else { props.state.shifts.push(shift); for (const employee of props.state.employees) employee.eligibleShiftIds.push(shift.id) }
  editor.value = null; notice(existing >= 0 ? '班次已更新。已有排班将使用新的班次时间，请检查规则冲突。' : '班次已添加，默认所有员工可排此班；可在人员管理中调整。')
}
function validAllowance(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > limits.allowance || Number(Number(value).toFixed(2)) !== Number(value)) { error.value = `班次津贴需为 0–${limits.allowance} 元，最多保留两位小数。`; return false }
  return true
}
function openAllowance(shift: Shift) {
  allowanceShiftId.value = shift.id
  allowanceDraft.value = shift.normalAllowance ?? 0
  error.value = ''; feedback.value = ''
}
function saveAllowance() {
  if (!validAllowance(allowanceDraft.value)) return
  const shift = props.state.shifts.find(item => item.id === allowanceShiftId.value)
  if (!shift) { error.value = '该班次已不存在，请重新选择。'; return }
  shift.normalAllowance = Number(allowanceDraft.value)
  allowanceShiftId.value = ''
  notice(`${shift.name}津贴已保存，现有排班的逐日津贴与汇总已更新。`)
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
  pendingDelete.value = null; notice(item.type === 'separation' ? `已删除「${item.name}」互斥规则，现有排班保持不变。` : `已删除${item.name}及其关联排班，并清理关联互斥规则。`)
}
function saveRules() {
  if (!Number.isFinite(Number(rulesDraft.minRestHours)) || Number(rulesDraft.minRestHours) < 0 || Number(rulesDraft.minRestHours) > limits.minRestHours) { error.value = `班间最短休息需在 0–${limits.minRestHours} 小时之间。`; return }
  if (!Number.isInteger(Number(rulesDraft.maxConsecutiveDays)) || Number(rulesDraft.maxConsecutiveDays) < 1 || Number(rulesDraft.maxConsecutiveDays) > 31) { error.value = '连续工作上限需要为 1–31 天的整数。'; return }
  if (weekdayDraftError.value) { error.value = weekdayDraftError.value; return }
  Object.assign(props.state.rules, { minRestHours: Number(rulesDraft.minRestHours), maxConsecutiveDays: Number(rulesDraft.maxConsecutiveDays) })
  delete props.state.rules.balanceWeekends
  if (weekdayWeightsEnabled.value) props.state.rules.weekdayWeights = { days: [...weekdayDays.value].sort((a, b) => a - b), percent: Number(weekdayPercent.value) }
  else delete props.state.rules.weekdayWeights
  notice('排班规则已保存。重新生成排班时生效，现有排班会重新检查冲突。')
}
function openSeparation(group?: SeparationGroup) {
  if (!group && separationGroups.value.length >= limits.separationGroups) { error.value = `最多支持 ${limits.separationGroups} 个互斥组，请先删除不再使用的规则。`; return }
  Object.assign(separationDraft, group ? { ...group, employeeIds: [...group.employeeIds], shiftIds: [...group.shiftIds] } : { id: '', name: '', employeeIds: [], shiftIds: [] })
  separationAllShifts.value = !group?.shiftIds.length
  editor.value = 'separation'; pendingDelete.value = null; error.value = ''; feedback.value = ''
}
function saveSeparation() {
  if (!separationDraft.id && separationGroups.value.length >= limits.separationGroups) { error.value = `最多支持 ${limits.separationGroups} 个互斥组。`; return }
  if (!validText(separationDraft.name, limits.groupName, '互斥规则名称')) return
  if (separationGroups.value.some(group => group.id !== separationDraft.id && group.name === separationDraft.name.trim())) { error.value = '已有同名互斥规则，请使用不同名称。'; return }
  const employeeIds = [...new Set(separationDraft.employeeIds)].filter(id => props.state.employees.some(employee => employee.id === id))
  const shiftIds = separationAllShifts.value ? [] : [...new Set(separationDraft.shiftIds)].filter(id => props.state.shifts.some(shift => shift.id === id))
  if (employeeIds.length < 2) { error.value = '互斥规则至少需要选择 2 位员工。'; return }
  if (!separationAllShifts.value && !shiftIds.length) { error.value = '请选择至少一个适用班次，或勾选适用于全部班次。'; return }
  const group: SeparationGroup = { id: separationDraft.id || `separation-${crypto.randomUUID()}`, name: separationDraft.name.trim(), employeeIds, shiftIds }
  const existing = separationGroups.value.findIndex(item => item.id === group.id)
  props.state.rules.separationGroups = existing < 0 ? [...separationGroups.value, group] : separationGroups.value.map(item => item.id === group.id ? group : item)
  editor.value = null; notice('互斥规则已保存。同一天的同一个适用班次，组内最多安排 1 人；现有排班会检查冲突。')
}
function separationMembers(group: SeparationGroup) { return props.state.employees.filter(employee => group.employeeIds.includes(employee.id)).map(employee => employee.name).join('、') }
function separationShifts(group: SeparationGroup) { return group.shiftIds.length ? props.state.shifts.filter(shift => group.shiftIds.includes(shift.id)).map(shift => shift.name).join('、') : '全部班次（含以后新增的班次）' }
</script>

<template>
  <section class="sp-settings">
    <p v-if="feedback" class="sp-settings-message" role="status">✓ {{ feedback }}</p>
    <p v-if="error" class="sp-settings-message sp-settings-error" role="alert">{{ error }}</p>
    <div v-if="pendingDelete" class="sp-settings-confirm" role="alertdialog" aria-modal="false" :aria-label="`确认删除${pendingDelete.name}`">
      <div><strong>删除「{{ pendingDelete.name }}」？</strong><p>{{ pendingDelete.type === 'separation' ? '删除后将不再限制这组人员同日同班，现有排班保持不变。' : '同时移除所有关联排班（含已锁定的安排），并清理不再适用的互斥规则。' }}此操作无法撤销。</p></div>
      <div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="pendingDelete = null">保留</button><button type="button" class="sp-settings-button sp-settings-danger" @click="confirmDelete">确认删除</button></div>
    </div>

    <template v-if="section === 'team'">
      <header class="sp-settings-heading"><div><p>设置人员的班次资格、月 / 周工时与请假。</p></div><button class="sp-settings-button sp-settings-primary" :disabled="state.employees.length >= limits.employees" @click="openEmployee()"><span aria-hidden="true">＋</span> 添加员工</button></header>
      <section class="sp-settings-config-card sp-settings-month-reference" aria-labelledby="sp-reference-heading">
        <div class="sp-settings-reference-heading">
          <div><h3 id="sp-reference-heading">月参考工时</h3><p>未单独设置的成员，月最低工时跟随此值。</p></div>
          <label class="sp-settings-field">排班月份<input :value="state.month" type="month" min="0001-01" max="9999-12" required aria-label="月参考工时的排班月份" @change="changeReferenceMonth" /></label>
        </div>
        <div class="sp-settings-reference-body">
          <div class="sp-settings-reference-summary">
            <div><strong>{{ monthReference.hours }}</strong><span>小时 / 月</span><span class="sp-settings-label">{{ monthReference.custom ? '手动设置' : '自动计算' }}</span></div>
            <p>建议 {{ monthReference.workdays }} 个工作日 × 8 小时 = {{ monthReference.suggestedHours }} 小时</p>
            <p>按本月工作日、法定节假日、调休补班及手动日历标记计算。</p>
          </div>
          <form class="sp-settings-reference-form" @submit.prevent="saveReferenceHours">
            <label class="sp-settings-field">手动设置本月参考工时<span class="sp-settings-input-unit"><input v-model.number="referenceDraft" type="number" min="0" max="744" step="any" required aria-label="手动月参考工时" /><span>小时</span></span></label>
            <div class="sp-settings-actions"><button type="submit" class="sp-settings-button">保存本月</button><button type="button" class="sp-settings-button" :disabled="!monthReference.custom" @click="resetReferenceHours">恢复自动</button></div>
          </form>
        </div>
        <p v-if="!monthReference.verified" class="sp-settings-calendar-warning" role="status">本月日历尚未核对，自动建议值为估算。请核对节假日和补班安排，或手动设置本月参考工时。</p>
        <p class="sp-settings-hint">月最低与周最低是排班必须满足的条件。人手、班次需求或休假使最低工时无法满足时，会提示无法生成；可为兼职或休假成员自定义最低工时，设为 0 可关闭对应最低限制。</p>
      </section>
      <div class="sp-settings-toolbar"><label class="sp-settings-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input v-model="employeeSearch" type="search" placeholder="搜索姓名、岗位或分组" aria-label="搜索员工" /></label><span>{{ state.employees.length }} / {{ limits.employees }} 位团队成员</span></div>
      <p v-if="state.employees.length >= limits.employees" class="sp-settings-hint">已达到 {{ limits.employees }} 人上限，可以编辑现有人员，或删除不再使用的人员后新增。</p>
      <form v-if="editor === 'employee'" class="sp-settings-editor" @submit.prevent="saveEmployee">
        <div class="sp-settings-card-heading"><h3>{{ employeeDraft.id ? '编辑员工' : '新成员资料' }}</h3><button type="button" class="sp-settings-icon-button" aria-label="关闭人员编辑" @click="editor = null; error = ''">×</button></div>
        <div class="sp-settings-form-grid sp-settings-employee-form-grid">
          <label class="sp-settings-field">员工姓名<input v-model="employeeDraft.name" :maxlength="limits.employeeText" required placeholder="例如：陈晨" /></label>
          <label class="sp-settings-field">岗位<input v-model="employeeDraft.role" :maxlength="limits.employeeText" placeholder="例如：值班主管" /></label>
          <label class="sp-settings-field">所属分组<input v-model="employeeDraft.group" :maxlength="limits.employeeText" placeholder="例如：一组" /></label>
          <div class="sp-settings-field sp-settings-month-minimum">
            <span>每月最低工时</span>
            <label class="sp-settings-checkbox"><input v-model="followMonthlyReference" type="checkbox" aria-label="月最低工时跟随月参考值" /><span>跟随月参考值 · {{ monthReference.hours }} 小时</span></label>
            <span v-if="!followMonthlyReference" class="sp-settings-input-unit"><input id="sp-employee-month-hours" v-model.number="employeeMonthHours" type="number" min="0" max="744" step="any" required aria-label="个人每月最低工时" /><span>小时</span></span>
            <p v-else class="sp-settings-hint">随排班月份与参考值自动更新。</p>
          </div>
          <label class="sp-settings-field">每周最低工时<span class="sp-settings-input-unit"><input v-model.number="employeeDraft.minHoursPerWeek" type="number" min="0" max="168" step="any" required aria-label="每周最低工时" /><span>小时</span></span></label>
          <label class="sp-settings-field">每周最高工时<span class="sp-settings-input-unit"><input v-model.number="employeeDraft.maxHoursPerWeek" type="number" min="0" max="168" step="any" required aria-label="每周最高工时" /><span>小时</span></span></label>
        </div>
        <p class="sp-settings-soft-note">周工时按周一至周日计算。月初、月末不足一周时，周最低按当月所占天数 ÷ 7 折算；周最高仍计入已知的跨月排班。月最低和周最低均按实际落在本月的工作时段计算，包括上月跨夜进入本月的工时。排班精确到分钟，最低向上、最高向下取整；最低设为 0 时不限制。</p>
        <fieldset class="sp-settings-fieldset"><legend>可上班次</legend><div class="sp-settings-choice-row"><label v-for="shift in state.shifts" :key="shift.id" class="sp-settings-checkbox"><input v-model="employeeDraft.eligibleShiftIds" type="checkbox" :value="shift.id"/><span class="sp-settings-dot" :style="{ background: shift.color }"/>{{ shift.name }} <small>{{ shift.start }}–{{ shift.end }}</small></label></div><p class="sp-settings-hint">不勾选任何班次时，该员工不会被自动排班。</p></fieldset>
        <fieldset class="sp-settings-fieldset"><legend>请假 / 不可排班日期</legend><div class="sp-settings-leave-row"><label class="sp-settings-field">开始日期<input v-model="leaveStart" type="date" min="0001-01-01" max="9999-12-31" /></label><label class="sp-settings-field">结束日期<input v-model="leaveEnd" type="date" min="0001-01-01" max="9999-12-31" /></label><button type="button" class="sp-settings-button" @click="addLeave">添加区间</button></div><div v-if="employeeDraft.unavailableDates.length" class="sp-settings-leave-dates"><button v-for="date in employeeDraft.unavailableDates" :key="date" type="button" :aria-label="`取消 ${date} 请假`" @click="employeeDraft.unavailableDates = employeeDraft.unavailableDates.filter(item => item !== date)">{{ date }} <span>×</span></button></div><div class="sp-settings-leave-summary"><small>{{ employeeDraft.unavailableDates.length ? `已设置 ${employeeDraft.unavailableDates.length} / ${limits.leaveDates} 天，点击日期可移除` : '暂无请假安排' }}</small><button v-if="employeeDraft.unavailableDates.length" type="button" class="sp-settings-link" @click="employeeDraft.unavailableDates = []">清除全部</button></div></fieldset>
        <div class="sp-settings-form-footer"><p>保存后检查已有排班，锁定安排不会自动删除。</p><div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="editor = null">取消</button><button type="submit" class="sp-settings-button sp-settings-primary">保存人员</button></div></div>
      </form>
      <div class="sp-settings-employee-grid">
        <article v-for="employee in displayedEmployees" :key="employee.id" class="sp-settings-employee-card">
          <div class="sp-settings-person"><span class="sp-settings-avatar" :style="{ background: employee.color }">{{ employee.name.slice(-2) }}</span><div><h3>{{ employee.name }}</h3><p>{{ employee.role || '未设岗位' }}<span v-if="employee.group"> · {{ employee.group }}</span></p></div><button class="sp-settings-edit" :aria-label="`编辑${employee.name}`" @click="openEmployee(employee)">编辑</button></div>
          <div class="sp-settings-badges"><span v-for="shift in state.shifts.filter(item => employee.eligibleShiftIds.includes(item.id))" :key="shift.id" :style="{ background: shift.color }">{{ shift.name }}</span><span v-if="!employee.eligibleShiftIds.length">暂不排班</span></div>
          <dl class="sp-settings-employee-hours"><div><dt>每月最低</dt><dd>{{ minimumMonthHours(state, employee) }} 小时 <small>{{ employee.minHoursPerMonth == null ? '跟随参考' : '自定义' }}</small></dd></div><div><dt>每周工时</dt><dd>{{ employee.minHoursPerWeek ?? 0 }}–{{ employee.maxHoursPerWeek }} 小时</dd></div></dl>
          <div class="sp-settings-card-bottom"><span>{{ employee.unavailableDates.length ? `请假 ${employee.unavailableDates.length} 天` : '未设置请假' }}</span><button class="sp-settings-remove" :aria-label="`删除${employee.name}`" @click="requestDelete('employee', employee.id, employee.name)">删除</button></div>
        </article>
      </div>
      <div v-if="!displayedEmployees.length" class="sp-settings-empty"><strong>{{ state.employees.length ? '没有找到匹配的成员' : '添加第一位团队成员' }}</strong><p>{{ state.employees.length ? '试试其他姓名、岗位或分组。' : '先建立人员名单，再为大家生成合适的排班。' }}</p></div>
    </template>

    <template v-else-if="section === 'shifts'">
      <header class="sp-settings-heading"><div><p>设置时间、每日基准人数及每班固定津贴，支持跨午夜。{{ state.shifts.length }} / {{ limits.shifts }} 个班次。</p></div><button class="sp-settings-button sp-settings-primary" :disabled="state.shifts.length >= limits.shifts" @click="openShift()"><span aria-hidden="true">＋</span> 新建班次</button></header>
      <p v-if="state.shifts.length >= limits.shifts" class="sp-settings-hint">已达到 {{ limits.shifts }} 个班次上限，可以编辑或删除现有班次。</p>
      <form v-if="editor === 'shift'" class="sp-settings-editor" @submit.prevent="saveShift"><div class="sp-settings-card-heading"><h3>{{ shiftDraft.id ? '编辑班次' : '新建班次' }}</h3><button type="button" class="sp-settings-icon-button" aria-label="关闭班次编辑" @click="editor = null; error = ''">×</button></div><div class="sp-settings-form-grid"><label class="sp-settings-field">班次名称<input v-model="shiftDraft.name" :maxlength="limits.shiftName" placeholder="例如：早班" required /></label><label class="sp-settings-field">日历简称<input v-model="shiftDraft.shortName" :maxlength="limits.shortName" placeholder="例如：早" required /></label><label class="sp-settings-field">开始时间<input v-model="shiftDraft.start" type="time" required /></label><label class="sp-settings-field">结束时间<input v-model="shiftDraft.end" type="time" required /></label><label class="sp-settings-field">{{ state.rules.weekdayWeights ? '每日基准人数' : '每日需求人数' }}<span class="sp-settings-input-unit"><input v-model.number="shiftDraft.required" type="number" min="0" :max="limits.required" step="1" required /><span>人</span></span></label><label class="sp-settings-field">班次津贴<span class="sp-settings-input-unit"><input v-model.number="shiftDraft.normalAllowance" type="number" min="0" :max="limits.allowance" step="0.01" required aria-label="班次津贴" /><span>元 / 人 / 班</span></span></label><div class="sp-settings-field">标记颜色<div class="sp-settings-colors"><button v-for="color in colors" :key="color" type="button" :style="{ background: color }" :class="{ active: shiftDraft.color === color }" :aria-label="`选择颜色 ${color}`" :aria-pressed="shiftDraft.color === color" @click="shiftDraft.color = color">{{ shiftDraft.color === color ? '✓' : '' }}</button><label class="sp-settings-custom-color"><input v-model="shiftDraft.color" type="color" aria-label="自定义班次颜色" /></label></div></div></div><p class="sp-settings-soft-note">本班次 {{ shiftDuration }} 小时<span v-if="shiftDraft.end < shiftDraft.start"> · 次日结束；整班津贴归入开始日期，跨月不拆金额</span>。人数设为 0 时不自动安排，可在日历手动指定。津贴按每人每班固定金额发放，每排一次该班领取一次，不按工时折算。设为 0 表示该班没有津贴。</p><div class="sp-settings-form-footer"><span/><div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="editor = null">取消</button><button type="submit" class="sp-settings-button sp-settings-primary">保存班次</button></div></div></form>
      <div class="sp-settings-shift-grid"><article v-for="shift in state.shifts" :key="shift.id" class="sp-settings-shift-card"><div class="sp-settings-shift-top"><span class="sp-settings-shift-mark" :style="{ background: shift.color }">{{ shift.shortName }}</span><div><h3>{{ shift.name }}</h3><p>{{ shift.end < shift.start ? '跨夜班次' : '当日班次' }}</p></div><button class="sp-settings-edit" :aria-label="`编辑${shift.name}`" @click="openShift(shift)">编辑</button></div><div class="sp-settings-shift-time">{{ shift.start }} <span>—</span> {{ shift.end }}<small v-if="shift.end < shift.start">次日</small></div><p class="sp-settings-shift-allowance">班次津贴 <strong>¥ {{ (shift.normalAllowance ?? 0).toFixed(2) }}</strong><span> / 人 / 班</span></p><div class="sp-settings-card-bottom"><span>{{ state.rules.weekdayWeights ? '每日基准' : '每日需要' }} <strong>{{ shift.required }}</strong> 人</span><button class="sp-settings-remove" :disabled="state.shifts.length <= 1" :aria-label="`删除${shift.name}`" @click="requestDelete('shift', shift.id, shift.name)">删除</button></div></article></div>
      <p class="sp-settings-footnote">新增班次默认适用于所有员工。更细的人员限制，请前往「人员管理」设置。<span v-if="state.rules.weekdayWeights">已启用上班权重：每日基准人数用于计算完整周总量，各天实际人数按周配额重新分配。</span></p>
    </template>

    <template v-else-if="section === 'rules'">

      <form class="sp-settings-config-card" @submit.prevent="saveRules">
        <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">01</span><h3>班间充分休息</h3><p>上个班结束到下个班开始，至少保留这段休息时间。</p></div><label class="sp-settings-input-unit"><input v-model.number="rulesDraft.minRestHours" type="number" min="0" :max="limits.minRestHours" step="any" required aria-label="班间最短休息小时数" /><span>小时</span></label></div>
        <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">02</span><h3>控制连续工作</h3><p>达到连续工作上限后，应安排休息或请假日。</p></div><label class="sp-settings-input-unit"><input v-model.number="rulesDraft.maxConsecutiveDays" type="number" min="1" max="31" step="1" required aria-label="最大连续工作天数" /><span>天</span></label></div>
        <section class="sp-settings-weekday-rule" aria-labelledby="sp-weekday-heading">
          <div class="sp-settings-rule"><div><span class="sp-settings-rule-number">03</span><h3 id="sp-weekday-heading">上班权重</h3><p>选择星期，为这些天合计分配团队一周总班次的指定比例，其余班次在其他星期均分。</p></div><label class="sp-settings-switch"><input v-model="weekdayWeightsEnabled" type="checkbox" aria-label="启用上班权重" /><span/><small>{{ weekdayWeightsEnabled ? '已开启' : '已关闭' }}</small></label></div>
          <div v-if="weekdayWeightsEnabled" class="sp-settings-weight-options">
            <fieldset class="sp-settings-fieldset sp-settings-weight-days"><legend>选择分配星期 · 可多选</legend><div class="sp-settings-weekday-options"><label v-for="day in weekdayOptions" :key="day.value" class="sp-settings-weekday-option" :class="{ selected: weekdayDays.includes(day.value) }"><input v-model="weekdayDays" type="checkbox" :value="day.value" :aria-label="`上班权重${day.label}`" /><span>{{ day.short }}</span></label></div></fieldset>
            <div class="sp-settings-weight-percent-row">
              <label class="sp-settings-field">所选星期合计占比<span class="sp-settings-input-unit"><input v-model.number="weekdayPercent" type="number" min="0" max="100" step="1" required aria-label="所选星期合计占比" :aria-invalid="!!weekdayDraftError" aria-describedby="sp-weight-percent-help" /><span>%</span></span></label>
              <p id="sp-weight-percent-help" class="sp-settings-hint">填写 0–100 的整数；选择全部七天时须为 100%。按整组班次向上取整，组内各天相差最多 1 班。</p>
            </div>
            <p v-if="weekdayDraftError" class="sp-settings-calendar-warning sp-settings-weight-validation" role="alert">{{ weekdayDraftError }}</p>
            <template v-else>
              <div class="sp-settings-weight-formula"><strong>完整周基准 {{ weekdayBaseline }} 班</strong><p>{{ weekdaySelectedLabel }}：合计 {{ weekdayPercent }}%，共 {{ weekdayFullSelected }} 班；其余星期共 {{ weekdayBaseline - weekdayFullSelected }} 班。</p></div>
              <div class="sp-settings-weight-capacity" role="status">
                <strong v-if="weekdayCapacity.maxPercent !== null">人数容量参考上限：{{ weekdayCapacity.maxPercent }}%</strong>
                <strong v-else>当前人员容量下，未找到可满足配额的整数比例</strong>
                <p>{{ weekdayCapacity.explanation }}</p>
                <p v-if="weekdayCapacity.maxPercent !== null && Number(weekdayPercent) > weekdayCapacity.maxPercent" class="sp-settings-weight-capacity-warning">当前占比超过容量参考上限，请调整比例或人员配置。保存不会自动降低占比。</p>
              </div>
              <section class="sp-settings-weight-preview" aria-label="本月上班权重配额预览">
                <div class="sp-settings-weight-preview-heading"><h4>{{ state.month }} 周配额预览</h4><span>本月共 <strong class="sp-settings-weight-month-total">{{ weekdayMonthlyTotal }}</strong> 班</span></div>
                <div class="sp-settings-weight-weeks">
                  <article v-for="week in weekdayPreviewWeeks" :key="week.id" class="sp-settings-weight-week" :data-week="week.id">
                    <header><strong>{{ week.dates[0]!.slice(5) }} — {{ week.dates[week.dates.length - 1]!.slice(5) }}</strong><span>{{ week.dates.length === 7 ? '完整周' : '部分周' }}</span></header>
                    <dl><div><dt>已选星期</dt><dd><strong class="sp-settings-weight-selected">{{ week.selectedTarget }}</strong> 班</dd></div><div><dt>其余星期</dt><dd><strong class="sp-settings-weight-other">{{ week.otherTarget }}</strong> 班</dd></div><div><dt>合计</dt><dd><strong class="sp-settings-weight-total">{{ week.totalTarget }}</strong> 班</dd></div></dl>
                    <details><summary>逐日可排范围</summary><ul><li v-for="date in week.dates" :key="date" :class="{ selected: week.selectedDates.includes(date) }"><span>{{ date.slice(5) }} {{ dayWeightLabel(date) }}</span><strong>{{ dayWeightRange(week, date) }} 班</strong></li></ul><p>同组内各天均分；范围中的具体数量由求解器安排，整组总数固定。</p></details>
                  </article>
                </div>
              </section>
            </template>
            <p class="sp-settings-soft-note"><strong>这是团队班次的硬性配额。</strong>启用后，班次设置中的每日需求人数作为基准，按每周总量重新分配到各天。月初、月末仅保留本月出现的星期份额，分别向上取整，不把缺失星期的班次补到本月。配额与工时、请假或锁定安排冲突时，排班不会生成；“允许岗位缺编”也不会放宽这些配额。</p>
          </div>
          <p v-else class="sp-settings-hint">关闭时按班次设置中的每日需求安排，不额外调整星期占比。</p>
        </section>
        <div class="sp-settings-form-footer"><p>本页更改保存后生效。月 / 周工时、班次资格与请假，在人员管理中设置。</p><button type="submit" class="sp-settings-button sp-settings-primary">保存规则</button></div>
      </form>
      <section class="sp-settings-config-card sp-settings-separation">
        <div class="sp-settings-card-heading"><div><h3>同日同班互斥</h3><p>指定人员互相错开，每个适用班次中，组内最多安排 1 人。当前 {{ separationGroups.length }} / {{ limits.separationGroups }} 组。</p></div><button type="button" class="sp-settings-button" :disabled="state.employees.length < 2 || separationGroups.length >= limits.separationGroups" @click="openSeparation()">＋ 添加互斥组</button></div>
        <p v-if="separationGroups.length >= limits.separationGroups" class="sp-settings-hint">已达到 {{ limits.separationGroups }} 个互斥组上限，可以编辑或删除已有规则。</p>
        <form v-if="editor === 'separation'" class="sp-settings-separation-editor" @submit.prevent="saveSeparation">
          <div class="sp-settings-card-heading"><h3>{{ separationDraft.id ? '编辑互斥组' : '新增互斥组' }}</h3><button type="button" class="sp-settings-icon-button" aria-label="关闭互斥组编辑" @click="editor = null; error = ''">×</button></div>
          <label class="sp-settings-field">规则名称<input v-model="separationDraft.name" :maxlength="limits.groupName" required placeholder="例如：主管轮值错开" /></label>
          <fieldset class="sp-settings-fieldset"><legend>选择互斥人员 · 至少 2 人<span class="sp-settings-selection-count">已选 {{ separationDraft.employeeIds.length }} 人</span></legend><div class="sp-settings-member-options"><label v-for="employee in state.employees" :key="employee.id" class="sp-settings-checkbox sp-settings-member-option" :class="{ selected: separationDraft.employeeIds.includes(employee.id) }"><input v-model="separationDraft.employeeIds" type="checkbox" :value="employee.id"/><span>{{ employee.name }}<small>{{ employee.role || employee.group || '团队成员' }}</small></span></label></div></fieldset>
          <fieldset class="sp-settings-fieldset"><legend>适用班次</legend><label class="sp-settings-checkbox"><input v-model="separationAllShifts" type="checkbox"/><span>适用于全部班次（包括以后新增的班次）</span></label><div v-if="!separationAllShifts" class="sp-settings-choice-row sp-settings-specific-shifts"><label v-for="shift in state.shifts" :key="shift.id" class="sp-settings-checkbox"><input v-model="separationDraft.shiftIds" type="checkbox" :value="shift.id"/><span class="sp-settings-dot" :style="{ background: shift.color }"/>{{ shift.name }}</label></div></fieldset>
          <p class="sp-settings-soft-note">例如选择甲、乙、丙三人后，任意两人都不能在同一天上同一个适用班次；可以分别上早班、晚班，或安排休息。</p>
          <div class="sp-settings-form-footer"><p>保存后立即检查现有排班，重新生成时自动遵守。</p><div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="editor = null">取消</button><button type="submit" class="sp-settings-button sp-settings-primary">保存互斥组</button></div></div>
        </form>
        <div v-if="separationGroups.length" class="sp-settings-separation-list"><article v-for="group in separationGroups" :key="group.id" class="sp-settings-separation-group"><div class="sp-settings-separation-title"><h3>{{ group.name }}</h3><span class="sp-settings-label">{{ group.employeeIds.length }} 人互斥</span><div class="sp-settings-actions"><button type="button" class="sp-settings-edit" :aria-label="`编辑互斥组${group.name}`" @click="openSeparation(group)">编辑</button><button type="button" class="sp-settings-remove" :aria-label="`删除互斥组${group.name}`" @click="requestDelete('separation', group.id, group.name)">删除</button></div></div><p class="sp-settings-separation-names">{{ separationMembers(group) }}</p><p class="sp-settings-separation-scope">适用：{{ separationShifts(group) }}<span>同日同班，组内最多 1 人</span></p></article></div>
        <p v-else-if="editor !== 'separation'" class="sp-settings-hint">{{ state.employees.length < 2 ? '先添加至少 2 位员工，即可设置人员互斥。' : '暂无互斥规则。可添加多组，同一位员工也可以属于多个组。' }}</p>
      </section>
      <aside class="sp-settings-explanation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></svg><div><h3>先遵守限制，再尽量均衡</h3><p>自动排班综合考虑已排工时、班次分配与人员互斥。启用上班权重后必须满足周配额；与其他限制冲突时会提示原因，保留原排班。锁定安排保持不变。</p></div></aside>
    </template>

    <template v-else>
      <header class="sp-settings-heading sp-settings-allowance-heading">
        <div><h2>班次津贴</h2><p>按最终排班，每人每班领取一次固定金额；跨夜和跨月津贴均归入开始日期。</p></div>
        <label class="sp-settings-field">汇总月份<input :value="state.month" type="month" min="0001-01" max="9999-12" required aria-label="津贴汇总月份" @change="changeReferenceMonth" /></label>
      </header>
      <div class="sp-settings-shift-grid">
        <article v-for="shift in state.shifts" :key="shift.id" class="sp-settings-shift-card sp-settings-allowance-card">
          <div class="sp-settings-shift-top"><span class="sp-settings-shift-mark" :style="{ background: shift.color }">{{ shift.shortName }}</span><div><h3>{{ shift.name }}</h3><p>{{ shift.start }}–{{ shift.end }}{{ shift.end < shift.start ? ' 次日' : '' }}</p></div></div>
          <form v-if="allowanceShiftId === shift.id" class="sp-settings-allowance-form" @submit.prevent="saveAllowance">
            <label class="sp-settings-field">固定津贴<span class="sp-settings-input-unit"><input v-model.number="allowanceDraft" type="number" min="0" :max="limits.allowance" step="0.01" required :aria-label="`${shift.name}班次津贴`" /><span>元 / 人 / 班</span></span></label>
            <div class="sp-settings-actions"><button type="button" class="sp-settings-button" @click="allowanceShiftId = ''; error = ''">取消津贴编辑</button><button type="submit" class="sp-settings-button sp-settings-primary">保存班次津贴</button></div>
          </form>
          <template v-else>
            <p class="sp-settings-allowance-value"><span>¥</span> {{ (shift.normalAllowance ?? 0).toFixed(2) }} <small>元 / 人 / 班</small></p>
            <div class="sp-settings-card-bottom"><span>{{ (shift.normalAllowance ?? 0) === 0 ? '暂未设置津贴' : '排一次班，计一次津贴' }}</span><button class="sp-settings-edit" :aria-label="`设置${shift.name}津贴`" @click="openAllowance(shift)">设置津贴</button></div>
          </template>
        </article>
      </div>
      <p class="sp-settings-footnote">津贴金额与「班次设置」共用，修改后会更新已有排班的金额。未排班或排为休息时不领取；月末跨夜班的整笔津贴计入本月，不拆到下月。</p>
    </template>
  </section>
</template>

<style scoped>
.sp-settings-reference-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.sp-settings-reference-heading>div{flex:1;min-width:180px}.sp-settings-reference-heading p{font-size:12px;line-height:1.7;color:#758a93;margin-top:7px}.sp-settings-reference-heading>.sp-settings-field{width:190px;max-width:100%}.sp-settings-reference-body{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-top:20px;flex-wrap:wrap}.sp-settings-reference-summary{flex:1;min-width:220px}.sp-settings-reference-summary>div{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}.sp-settings-reference-summary strong{font-size:32px;font-variant-numeric:tabular-nums;font-weight:650;color:#245b4e;line-height:1.3}.sp-settings-reference-summary>div>span:not(.sp-settings-label){font-size:12px;color:#7a8f97}.sp-settings-reference-summary p{font-size:12px;color:#71878e;line-height:1.8;margin-top:8px}.sp-settings-reference-summary p+p{font-size:11px;margin-top:1px}.sp-settings-reference-form{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;max-width:100%}.sp-settings-reference-form>.sp-settings-field{width:180px;max-width:100%;flex:1}.sp-settings-reference-form>.sp-settings-actions{flex-wrap:wrap}.sp-settings-calendar-warning{margin-top:16px!important;background:#fff8e9;border:1px solid #eedcb3;border-radius:8px;color:#957542;font-size:12px;line-height:1.7;padding:10px 12px}.sp-settings-month-reference>.sp-settings-hint{padding-top:12px;margin-top:16px!important;border-top:1px solid #edf1f2;color:#7b9096}.sp-settings-month-minimum>.sp-settings-hint{margin-top:0!important;font-weight:400}.sp-settings-month-minimum>.sp-settings-checkbox{font-weight:400;align-items:flex-start;min-height:24px}.sp-settings-month-minimum .sp-settings-checkbox input{width:16px;height:16px;min-height:16px;padding:0;margin-top:2px}.sp-settings-employee-hours{display:grid;gap:9px;margin:0 0 16px;font-size:12px}.sp-settings-employee-hours>div{display:flex;justify-content:space-between;align-items:baseline;gap:6px;flex-wrap:wrap}.sp-settings-employee-hours dt{color:#83979f}.sp-settings-employee-hours dd{margin:0;color:#4d6973;text-align:right;font-variant-numeric:tabular-nums}.sp-settings-employee-hours small{color:#859b95;font-size:10px;white-space:nowrap;margin-left:4px}
@media(max-width:720px){.sp-settings-reference-body{gap:18px}.sp-settings-reference-summary{min-width:0;flex-basis:100%}.sp-settings-reference-form{width:100%}.sp-settings-reference-form>.sp-settings-field{min-width:120px}.sp-settings-reference-heading>.sp-settings-field{width:100%}.sp-settings-reference-summary strong{font-size:29px}}
@media(max-width:520px){.sp-settings-employee-form-grid{grid-template-columns:1fr!important}.sp-settings-reference-form>.sp-settings-field{flex-basis:100%}.sp-settings-reference-form>.sp-settings-actions{width:100%}.sp-settings-reference-form>.sp-settings-actions>.sp-settings-button{flex:1}}
.sp-settings-shift-top h3{overflow-wrap:anywhere}.sp-settings-shift-mark{min-width:44px;min-height:44px;height:auto!important;max-width:96px;width:auto!important;padding:8px;overflow-wrap:anywhere;font-size:15px!important;text-align:center}
.sp-settings{color:#263c45;font-size:14px;max-width:1440px;margin:0 auto}.sp-settings *{box-sizing:border-box}.sp-settings button,.sp-settings input{font:inherit}.sp-settings button{cursor:pointer;transition:background .15s,box-shadow .15s}.sp-settings button:disabled{cursor:not-allowed;opacity:.38}.sp-settings input:focus-visible,.sp-settings button:focus-visible{outline:3px solid #99ddd4;outline-offset:3px}.sp-settings h2,.sp-settings h3,.sp-settings p{margin:0}.sp-settings h2{font-size:19px;font-weight:650;line-height:1.4;letter-spacing:-.5px}.sp-settings h3{font-size:15px;font-weight:650}.sp-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:18px}.sp-settings-heading p{color:#829099;line-height:1.7;margin-top:0;font-size:13px}.sp-settings-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;white-space:nowrap;padding:9px 16px;border:1px solid #dce5e8;border-radius:9px;background:#fff;color:#4e626b;font-weight:600!important;font-size:13px!important}.sp-settings-button:hover{background:#f1f6f5}.sp-settings-primary{background:#245b4e;border-color:#245b4e;color:#fff;box-shadow:0 3px 8px #245b4e14}.sp-settings-primary:hover{background:#1d4a3f}.sp-settings-actions{display:flex;gap:9px}.sp-settings-message{padding:13px 16px!important;margin-bottom:18px!important;border:1px solid #bee5d8;border-radius:10px;background:#ecf9f3;color:#247863;line-height:1.6}.sp-settings-error{background:#fff1ef;color:#ba5145;border-color:#f3cec5}.sp-settings-confirm{display:flex;gap:20px;justify-content:space-between;align-items:center;background:#fff8ef;border:1px solid #eedbbc;padding:20px;border-radius:14px;margin-bottom:20px}.sp-settings-confirm p{font-size:12px;color:#95734f;line-height:1.6;margin-top:7px}.sp-settings-danger{background:#b95047;color:#fff;border-color:#b95047}.sp-settings-danger:hover{background:#a53f37}.sp-settings-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.sp-settings-toolbar>span{font-size:12px;color:#8a979c}.sp-settings-search{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #e0e7eb;border-radius:9px;padding:9px 12px;max-width:350px;flex:1}.sp-settings-search svg{width:17px;fill:none;stroke:#93a3aa;stroke-width:1.7;flex-shrink:0}.sp-settings-search input{border:0;background:none;width:100%;min-width:0;font-size:13px;color:#344d55}.sp-settings-search input:focus-visible{outline:none}.sp-settings-search:focus-within{border-color:#245b4e;box-shadow:0 0 0 3px #245b4e10}.sp-settings-editor,.sp-settings-config-card{padding:24px;border:1px solid #e1e9eb;border-radius:14px;background:#fff;margin-bottom:20px}.sp-settings-editor{border-color:#96d5cc;box-shadow:0 3px 16px #174d4010}.sp-settings-card-heading{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:22px}.sp-settings-card-heading p{font-size:12px;color:#83939b;margin-top:7px}.sp-settings-icon-button{border:0;background:#f1f5f5;border-radius:8px;width:32px;height:32px;color:#698089;font-size:22px!important}.sp-settings-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.sp-settings-field{display:flex;flex-direction:column;gap:9px;font-size:12px;font-weight:600;color:#657982;min-width:0}.sp-settings-field input{padding:10px 12px;border:1px solid #dfe7e9;border-radius:8px;width:100%;min-width:0;background:#fcfdfd;color:#304d56;min-height:40px;font-weight:400}.sp-settings-field input:focus{border-color:#47b5a8;outline:none;box-shadow:0 0 0 3px #245b4e10}.sp-settings-input-unit{display:flex;align-items:center;gap:8px;border:1px solid #dfe7e9;border-radius:8px;min-height:40px;background:#fcfdfd;padding-right:12px;min-width:0}.sp-settings-input-unit input{border:0;background:none;width:100%;min-width:0;padding:10px 12px;color:#304d56}.sp-settings-input-unit input:focus-visible{outline:none;box-shadow:none}.sp-settings-input-unit:focus-within{border-color:#47b5a8;box-shadow:0 0 0 3px #245b4e10}.sp-settings-input-unit>span{font-size:12px;color:#93a1a7;white-space:nowrap;font-weight:400}.sp-settings-fieldset{border:0;padding:0;margin:25px 0 0;min-width:0}.sp-settings-fieldset legend{font-size:12px;color:#657982;font-weight:600;margin-bottom:12px}.sp-settings-choice-row{display:flex;gap:12px;flex-wrap:wrap}.sp-settings-checkbox{display:flex;gap:8px;align-items:center;color:#49646a;line-height:1.5;font-size:13px}.sp-settings-checkbox input{accent-color:#245b4e;width:16px;height:16px;flex-shrink:0;margin:0}.sp-settings-checkbox small{color:#99a5a9;font-size:11px}.sp-settings-dot{width:9px;height:9px;display:inline-block;border-radius:50%;box-shadow:0 0 0 1px #364b4215}.sp-settings-hint{font-size:12px;color:#94a2a8;line-height:1.7;margin-top:10px!important}.sp-settings-leave-row{display:flex;gap:12px;align-items:flex-end}.sp-settings-leave-row>.sp-settings-field{flex:1}.sp-settings-leave-dates{display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow:auto;margin-top:14px}.sp-settings-leave-dates button{background:#f0f7f5;border:1px solid #dceae4;padding:5px 8px;border-radius:5px;color:#5b7a70;font-size:11px}.sp-settings-leave-dates span{margin-left:4px}.sp-settings-leave-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;color:#8a9a9f}.sp-settings-leave-summary small{font-size:11px}.sp-settings-link{border:0;background:none;color:#245b4e;padding:4px;font-size:12px!important}.sp-settings-form-footer{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-top:21px;margin-top:22px;border-top:1px solid #edf1f2}.sp-settings-form-footer p{font-size:12px;color:#8b9ca2;line-height:1.7}.sp-settings-employee-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:17px}.sp-settings-employee-card,.sp-settings-shift-card{background:#fff;border:1px solid #e3e9ec;border-radius:14px;padding:20px;min-width:0;box-shadow:0 2px 3px #1a3a4002}.sp-settings-person,.sp-settings-shift-top{display:flex;align-items:center;gap:12px}.sp-settings-person>div,.sp-settings-shift-top>div{min-width:0}.sp-settings-person h3{overflow-wrap:anywhere}.sp-settings-avatar{width:43px;height:43px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;color:#496976}.sp-settings-person p,.sp-settings-shift-top p{font-size:11px;color:#94a1a8;margin-top:5px;line-height:1.6}.sp-settings-edit{margin-left:auto;background:none;border:0;color:#63958d;font-size:12px!important;padding:6px 0 6px 8px;flex-shrink:0}.sp-settings-edit:hover{color:#245b4e}.sp-settings-badges{display:flex;flex-wrap:wrap;gap:6px;margin:19px 0 18px;min-height:23px}.sp-settings-badges>span{font-size:11px;padding:5px 10px;border-radius:5px;color:#4c6669;background:#eff3f4;line-height:1}.sp-settings-card-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid #f0f3f4;padding-top:14px;font-size:11px;color:#87979e;line-height:1.5}.sp-settings-remove{background:none;border:0;color:#b4bec2;padding:4px 0 4px 8px;font-size:11px!important}.sp-settings-remove:hover:not(:disabled){color:#c36959}.sp-settings-empty{padding:60px 20px;text-align:center;color:#648077;background:#fff;border:1px dashed #d9e3e5;border-radius:14px}.sp-settings-empty p{font-size:13px;margin-top:12px;color:#91a1a7}.sp-settings-colors{display:flex;align-items:center;gap:8px;min-height:40px;flex-wrap:wrap}.sp-settings-colors>button{width:27px;height:27px;border-radius:50%;border:2px solid transparent;color:#446960;padding:0;flex-shrink:0}.sp-settings-colors>button.active{box-shadow:0 0 0 2px #fff,0 0 0 3px #245b4e}.sp-settings-custom-color input{width:30px;height:30px;min-height:0;padding:2px;cursor:pointer;border-radius:50%}.sp-settings-soft-note{background:#edf6f3;border:1px solid #dcece6;border-radius:10px;padding:14px 17px;font-size:12px;color:#5d7c72;line-height:1.8;margin-top:20px!important}.sp-settings-soft-note p{margin-top:6px}.sp-settings-shift-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.sp-settings-shift-mark{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:650;flex-shrink:0}.sp-settings-shift-time{font-size:28px;color:#314b54;font-weight:600;margin:24px 0;letter-spacing:-.7px;white-space:nowrap}.sp-settings-shift-time>span{font-size:20px;color:#b6c3c7;margin:0 8px}.sp-settings-shift-time>small{font-size:10px;color:#8a9a9f;font-weight:400;vertical-align:top;letter-spacing:0;margin-left:5px}.sp-settings-footnote{font-size:12px;color:#8e9da4;margin-top:22px!important;line-height:1.8}.sp-settings-rule{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:25px 0;border-bottom:1px solid #edf1f2}.sp-settings-rule:first-child{padding-top:2px}.sp-settings-rule:nth-child(3){border-bottom:0}.sp-settings-rule>div{position:relative;padding-left:42px;flex:1}.sp-settings-rule-number{position:absolute;left:0;top:0;background:#eaf5f1;color:#68998c;border-radius:8px;padding:7px;font-size:11px}.sp-settings-rule h3{padding-top:5px}.sp-settings-rule p{font-size:12px;color:#8b9aa1;line-height:1.8;margin-top:8px}.sp-settings-rule>.sp-settings-input-unit{width:120px;flex-shrink:0}.sp-settings-switch{display:flex;align-items:center;gap:9px;position:relative;cursor:pointer;flex-shrink:0}.sp-settings-switch input{position:absolute;left:0;top:0;opacity:0;width:40px;height:23px}.sp-settings-switch>span{pointer-events:none;width:40px;height:23px;background:#d4dee1;border-radius:20px;position:relative;transition:background .2s}.sp-settings-switch>span:after{content:'';position:absolute;width:17px;height:17px;top:3px;left:3px;border-radius:50%;background:white;box-shadow:0 1px 3px #133e4229;transition:transform .2s}.sp-settings-switch input:checked+span{background:#245b4e}.sp-settings-switch input:checked+span:after{transform:translateX(17px)}.sp-settings-switch input:focus-visible+span{outline:3px solid #99ddd4;outline-offset:3px}.sp-settings-switch small{font-size:11px;color:#8b9da3}.sp-settings-explanation{display:flex;align-items:flex-start;gap:17px;padding:22px 24px;background:#eef4f7;border:1px solid #dfe9ee;border-radius:14px;color:#668293}.sp-settings-explanation svg{width:26px;height:26px;stroke:#7a9ba7;fill:none;stroke-width:1.5;flex-shrink:0}.sp-settings-explanation h3{font-size:13px}.sp-settings-explanation p{font-size:12px;line-height:1.9;margin-top:8px}.sp-settings-label{font-size:10px;color:#8e9fa6;background:#f2f6f6;padding:5px 8px;border-radius:5px;white-space:nowrap}.sp-settings-full-field{grid-column:1/-1}.sp-settings input[type=number]{appearance:textfield}.sp-settings input[type=number]::-webkit-inner-spin-button{opacity:.4}
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
.sp-settings-allowance-heading>div{flex:1;min-width:0}.sp-settings-allowance-heading p{margin-top:8px}.sp-settings-allowance-heading>.sp-settings-field{width:185px;flex-shrink:0}.sp-settings-allowance-value{font-size:27px;line-height:1.5;font-weight:600;color:#99722f;margin:24px 0!important;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.sp-settings-allowance-value>span{font-size:18px;font-weight:500}.sp-settings-allowance-value>small{display:block;margin-top:5px;color:#99a59f;font-size:11px;font-weight:400}.sp-settings-allowance-form{margin-top:21px}.sp-settings-allowance-form>.sp-settings-actions{margin-top:17px;justify-content:flex-end;flex-wrap:wrap}.sp-settings-allowance-form .sp-settings-button{font-size:11px!important;padding:9px 12px}.sp-settings-allowance-card .sp-settings-card-bottom>.sp-settings-edit{padding:4px 0;margin-left:0}@media(max-width:720px){.sp-settings-allowance-heading{flex-wrap:wrap}.sp-settings-allowance-heading>div,.sp-settings-allowance-heading>.sp-settings-field{width:100%;flex-basis:100%}.sp-settings-allowance-form>.sp-settings-actions>.sp-settings-button{flex:1}}
</style>
