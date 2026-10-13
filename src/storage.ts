import { strToU8, zipSync } from 'fflate'
import { dayInfo, calculatePayroll, createPayrollConfig, payrollRows as makePayrollRows } from './payroll.ts'
import type { DayKind, PlannerDocument, PayrollSettings, PayrollResult } from './payroll'
import type { Shift } from './domain.ts'
import { hoursToMinutes, monthlyHoursByEmployee } from './hours.ts'
import { findWeightedWeek, weekdayWeightRuleError, weightedWeeks } from './weekday-weights.ts'

export const STORAGE_KEY = 'shift-planner:v1'
const MAX_BYTES = 2 * 1024 * 1024
type RecordValue = Record<string, unknown>
type Cell = string | number

function fail(label: string): never { throw new Error(`备份格式错误：${label}`) }
function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`)
  return value as RecordValue
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label}必须是数组且不超过 ${max} 项`)
  return value
}
function string(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}不是有效文本`)
  return value
}
function id(value: unknown, label: string): string {
  const result = string(value, 64, label)
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) fail(`${label}只能使用字母、数字、下划线和短横线`)
  return result
}
function number(value: unknown, min: number, max: number, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label}超出范围 ${min}–${max}`)
  return value
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值`)
  return value
}
function currency(value: unknown, label: string): number {
  const amount = number(value, 0, 100000000, label)
  if (Math.round(amount * 100) / 100 !== amount) fail(`${label}最多保留两位小数`)
  return amount
}
function daysInMonth(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
}
function monthValue(value: unknown): string {
  const result = string(value, 7, '月份')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result) || Number(result.slice(0, 4)) < 1) fail('月份必须为 YYYY-MM')
  return result
}
function dateValue(value: unknown, label: string): string {
  const result = string(value, 10, label)
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(result)) fail(`${label}必须为 YYYY-MM-DD`)
  const [year, month, day] = result.split('-').map(Number)
  if (year! < 1 || day! > daysInMonth(year!, month!)) fail(`${label}日期不存在`)
  return result
}
function color(value: unknown, label: string): string {
  const result = string(value, 9, label)
  if (!/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/.test(result)) fail(`${label}必须为十六进制颜色`)
  return result
}
function time(value: unknown, label: string): string {
  const result = string(value, 5, label)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) fail(`${label}必须为 HH:mm`)
  return result
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label}存在重复项`)
}

/** Parse untrusted manual backups into fresh objects; never merge imported keys into live state. */
export function parseBackup(text: string): PlannerDocument {
  if (typeof text !== 'string' || text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) fail('文件超过 2 MB')
  let decoded: unknown
  try { decoded = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { fail('无法读取 JSON 文件') }
  const root = object(decoded, '备份')
  if (root.version !== 1) fail('不支持此备份版本')
  const shifts = list(root.shifts, 24, '班次').map((entry, index): Shift => {
    const s = object(entry, `班次 ${index + 1}`)
    const shiftId = id(s.id, '班次 ID')
    if (shiftId === 'off') fail('off 为休息专用标识')
    const start = time(s.start, '开始时间'), end = time(s.end, '结束时间')
    if (start === end) fail('班次开始和结束时间不能相同')
    const staffingMode = s.staffingMode
    if (staffingMode !== undefined && staffingMode !== 'minimum' && staffingMode !== 'fixed') fail('班次人数模式必须为 minimum 或 fixed')
    return { id: shiftId, name: string(s.name, 60, '班次名称'), shortName: string(s.shortName, 8, '班次简称'), start, end, color: color(s.color, '班次颜色'), required: number(s.required, 0, 200, '每日需求人数', true), ...(staffingMode === undefined ? {} : { staffingMode }), ...(s.normalAllowance === undefined ? {} : { normalAllowance: currency(s.normalAllowance, '班次普通津贴') }) }
  })
  unique(shifts.map(s => s.id), '班次 ID')
  const shiftIds = new Set(shifts.map(s => s.id))
  const employees = list(root.employees, 200, '员工').map((entry, index) => {
    const e = object(entry, `员工 ${index + 1}`)
    const eligibleShiftIds = list(e.eligibleShiftIds, 24, '可上班次').map(value => id(value, '可上班次 ID'))
    unique(eligibleShiftIds, '可上班次')
    if (eligibleShiftIds.some(value => !shiftIds.has(value))) fail('员工引用了不存在的班次')
    const unavailableDates = list(e.unavailableDates, 3660, '请假日期').map(value => dateValue(value, '请假日期'))
    unique(unavailableDates, '请假日期')
    const minHoursPerMonth = e.minHoursPerMonth === undefined || e.minHoursPerMonth === null ? null : number(e.minHoursPerMonth, 0, 744, '每月最低工时')
    const minHoursPerWeek = e.minHoursPerWeek === undefined ? 0 : number(e.minHoursPerWeek, 0, 168, '每周最低工时')
    const maxHoursPerWeek = number(e.maxHoursPerWeek, 0, 168, '每周最高工时')
    if (minHoursPerWeek > maxHoursPerWeek || hoursToMinutes(minHoursPerWeek, 'ceil') > hoursToMinutes(maxHoursPerWeek, 'floor')) fail('每周最低工时不能超过最高工时（按分钟核算）')
    return { id: id(e.id, '员工 ID'), name: string(e.name, 80, '姓名'), role: string(e.role, 80, '岗位', true), group: string(e.group, 80, '分组', true), color: color(e.color, '员工颜色'), minHoursPerMonth, minHoursPerWeek, maxHoursPerWeek, eligibleShiftIds, unavailableDates }
  })
  unique(employees.map(e => e.id), '员工 ID')
  const employeeIds = new Set(employees.map(e => e.id))
  const occupied = new Set<string>()
  const assignments = list(root.assignments, 80000, '排班').map((entry, index) => {
    const a = object(entry, `排班 ${index + 1}`)
    const employeeId = id(a.employeeId, '排班员工 ID'), shiftId = id(a.shiftId, '排班班次 ID'), date = dateValue(a.date, '排班日期')
    if (!employeeIds.has(employeeId) || (shiftId !== 'off' && !shiftIds.has(shiftId))) fail('排班引用了不存在的员工或班次')
    const key = `${employeeId}:${date}`
    if (occupied.has(key)) fail('同一员工同一天存在多条排班')
    occupied.add(key)
    const locked = bool(a.locked, '锁定状态')
    return { employeeId, date, shiftId, locked }
  })
  const r = object(root.rules, '规则')
  const state: PlannerDocument = {
    version: 1, teamName: string(root.teamName, 100, '团队名称'), month: monthValue(root.month), employees, shifts, assignments,
    rules: { minRestHours: number(r.minRestHours, 0, 48, '最短休息小时'), maxConsecutiveDays: number(r.maxConsecutiveDays, 1, 31, '最多连续工作天数', true) },
  }
  // Preserve old backups without applying their retired weekend fairness objective.
  if (r.balanceWeekends !== undefined) state.rules.balanceWeekends = bool(r.balanceWeekends, '旧版周末选项')
  const weightsError = weekdayWeightRuleError(r.weekdayWeights)
  if (weightsError) fail(weightsError)
  if (r.weekdayWeights !== undefined) {
    const weights = r.weekdayWeights as { days: number[]; percent: number }
    state.rules.weekdayWeights = { days: [...weights.days], percent: weights.percent }
  }
  if (root.monthlyReferenceHours !== undefined) {
    const raw = object(root.monthlyReferenceHours, '月参考工时')
    if (Object.keys(raw).length > 1200) fail('月参考工时最多保存 1200 个月')
    const references: Record<string, number> = Object.create(null)
    for (const [month, hours] of Object.entries(raw)) references[monthValue(month)] = number(hours, 0, 744, '月参考工时')
    state.monthlyReferenceHours = references
  }
  if (r.separationGroups !== undefined) {
    const groups = list(r.separationGroups, 200, '互斥组').map((entry, index) => {
      const group = object(entry, `互斥组 ${index + 1}`)
      const members = list(group.employeeIds, 200, '互斥组员工').map(value => id(value, '互斥组员工 ID'))
      if (members.length < 2) fail('互斥组至少需要 2 名员工')
      unique(members, '互斥组员工')
      if (members.some(member => !employeeIds.has(member))) fail('互斥组引用了不存在的员工')
      const selectedShifts = list(group.shiftIds, 24, '互斥组班次').map(value => id(value, '互斥组班次 ID'))
      unique(selectedShifts, '互斥组班次')
      if (selectedShifts.some(shift => !shiftIds.has(shift))) fail('互斥组引用了不存在的班次')
      return { id: id(group.id, '互斥组 ID'), name: string(group.name, 80, '互斥组名称'), employeeIds: members, shiftIds: selectedShifts }
    })
    unique(groups.map(group => group.id), '互斥组 ID')
    state.rules.separationGroups = groups
  }
  if (root.payroll !== undefined) {
    const p = object(root.payroll, '工资设置')
    const rawSalaries = object(p.employeeSalaries, '员工薪资')
    if (Object.keys(rawSalaries).length > employees.length) fail('员工薪资数量超出员工人数')
    const employeeSalaries: Record<string, number> = Object.create(null)
    for (const [employeeId, salary] of Object.entries(rawSalaries)) {
      if (!employeeIds.has(employeeId)) fail('薪资引用了不存在的员工')
      employeeSalaries[employeeId] = number(salary, 0, 100000000, '员工月薪')
    }
    const payroll: PayrollSettings = {
      monthlySalary: number(p.monthlySalary, 0, 100000000, '默认月薪'),
      monthlyWorkdays: number(p.monthlyWorkdays, 1, 31, '月计薪天数'),
      hoursPerDay: number(p.hoursPerDay, 0.25, 24, '每日标准工时'),
      statutoryMultiplier: number(p.statutoryMultiplier, 0, 10, '法定节假日加班倍数'),
      restdayMultiplier: number(p.restdayMultiplier, 0, 10, '休息日加班倍数'),
      ordinaryMultiplier: number(p.ordinaryMultiplier, 0, 10, '工作日加班倍数'),
      restdayCompensated: bool(p.restdayCompensated, '休息日已安排补休'), employeeSalaries,
    }
    if (p.dateShiftMultipliers !== undefined) {
      const rawDates = object(p.dateShiftMultipliers, '日期班次倍率')
      if (Object.keys(rawDates).length > 3660) fail('日期班次倍率最多保存 3660 天')
      const dates: Record<string, Record<string, number>> = Object.create(null)
      for (const [date, value] of Object.entries(rawDates)) {
        dateValue(date, '津贴日期')
        const rawShifts = object(value, '日期班次倍率')
        if (Object.keys(rawShifts).length > shifts.length) fail('日期班次倍率数量超出班次数量')
        const multipliers: Record<string, number> = Object.create(null)
        for (const [shiftId, multiplier] of Object.entries(rawShifts)) {
          if (!shiftIds.has(shiftId)) fail('日期班次倍率引用了不存在的班次')
          multipliers[shiftId] = number(multiplier, 0, 10, '日期班次倍率')
        }
        dates[date] = multipliers
      }
      payroll.dateShiftMultipliers = dates
    }
    state.payroll = payroll
  }
  if (root.calendar !== undefined) {
    const rawCalendar = object(root.calendar, '日期类型')
    if (Object.keys(rawCalendar).length > 3660) fail('日期类型最多 3660 项')
    const calendar: Record<string, DayKind> = Object.create(null)
    for (const [date, kind] of Object.entries(rawCalendar)) {
      dateValue(date, '日期类型')
      if (kind !== 'workday' && kind !== 'restday' && kind !== 'statutory') fail('未知的日期类型')
      calendar[date] = kind
    }
    state.calendar = calendar
  }
  return state
}

export function backupJSON(state: PlannerDocument): string {
  // Validate exports too, so broken in-memory data never overwrites a usable backup.
  const safe = parseBackup(JSON.stringify(state))
  const formatted = JSON.stringify(safe, null, 2)
  return new TextEncoder().encode(formatted).length <= MAX_BYTES ? formatted : JSON.stringify(safe)
}
export function loadSaved(): PlannerDocument | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === null ? null : parseBackup(raw)
}
export function saveLocal(state: PlannerDocument): void { localStorage.setItem(STORAGE_KEY, backupJSON(state)) }

function duration(start: string, end: string): number {
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  return ((minutes(end) - minutes(start) + 1440) % 1440) / 60
}
function documentPayroll(state: PlannerDocument): PayrollResult {
  const defaults = createPayrollConfig()
  return calculatePayroll(state, { payroll: state.payroll ?? defaults.payroll, calendar: state.calendar ?? {} })
}
function table(state: PlannerDocument, payroll = documentPayroll(state)): Cell[][] {
  const [year, month] = state.month.split('-').map(Number)
  const dates = Array.from({ length: daysInMonth(year!, month!) }, (_, i) => `${state.month}-${String(i + 1).padStart(2, '0')}`)
  const shifts = new Map(state.shifts.map(s => [s.id, s]))
  const assignments = new Map(state.assignments.map(a => [`${a.employeeId}:${a.date}`, a]))
  const actualHours = monthlyHoursByEmployee(state)
  const amounts = new Map(payroll.dailyRows.map(row => [`${row.employeeId}:${row.date}`, row]))
  const totals = new Map(payroll.rows.map(row => [row.employeeId, row.totalAllowance]))
  const headers = dates.map(date => `${date}（${dayInfo(date, state.calendar ?? {}).label}）`)
  return [ ['姓名', '岗位', '分组', ...headers, '本月实际工时', '额外津贴（元）'], ...state.employees.map(employee => {
    const cells = dates.map(date => {
      const assignment = assignments.get(`${employee.id}:${date}`)
      const shift = assignment ? shifts.get(assignment.shiftId) : undefined
      const daily = amounts.get(`${employee.id}:${date}`)
      const label = shift ? shift.name : employee.unavailableDates.includes(date) ? '请假' : daily?.carriedShiftIds.length ? '跨夜续班' : '休息'
      return daily && daily.totalAllowance > 0 ? `${label}\n+¥${daily.totalAllowance.toFixed(2)}` : label
    })
    return [employee.name, employee.role, employee.group, ...cells, Math.round((actualHours.get(employee.id) ?? 0) * 100) / 100, totals.get(employee.id) ?? 0]
  }) ]
}
function csvCell(cell: Cell): string {
  let value = String(cell)
  if (typeof cell === 'string' && /^[\s\uFEFF]*[=+@-]/.test(value)) value = `'${value}`
  return `"${value.replace(/"/g, '""')}"`
}
export function scheduleCSV(state: PlannerDocument): string {
  return '\uFEFF' + table(parseBackup(JSON.stringify(state))).map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function columnName(index: number): string {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result
  return result
}
function sheet(rows: Cell[][]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="1" topLeftCell="D2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="3" width="16" customWidth="1"/><col min="4" max="100" width="14" customWidth="1"/></cols><sheetData>${rows.map((row, ri) => `<row r="${ri + 1}">${row.map((cell, ci) => {
    const address = `${columnName(ci)}${ri + 1}`
    if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${address}" s="${ri ? 0 : 1}"><v>${cell}</v></c>`
    return `<c r="${address}" s="${ri ? 0 : 1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(cell))}</t></is></c>`
  }).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${columnName(Math.max(0, ...(rows.map(row => row.length - 1))))}${Math.max(1, rows.length)}"/></worksheet>`
}
/** A real Excel workbook; text is inlineStr, never a formula, including user-provided names. */
export function scheduleXLSX(state: PlannerDocument, options: { payrollRows?: Cell[][] } = {}): Uint8Array {
  const safe = parseBackup(JSON.stringify(state))
  const payroll = documentPayroll(safe)
  const rows: Cell[][][] = [table(safe, payroll), [['班次', '简称', '开始时间', '结束时间', '人数模式', '每日人数', '单班工时', '固定班次津贴（元/人/班）'], ...safe.shifts.map(s => [s.name, s.shortName, s.start, s.end, s.staffingMode === 'fixed' ? '每日固定' : '每日最少', s.required, duration(s.start, s.end), s.normalAllowance ?? 0]), ['说明', '每日最少：每天该班次不得少于设定人数，可增加安排，设为 0 仍可排班。每日固定：每天该班次须恰好达到设定人数，设为 0 不得安排。班次格子归属开始日期；本月工时按实际时段拆月，上月跨夜进入本月的部分计入，月底跨出部分不计。']], options.payrollRows ?? makePayrollRows(payroll)]
  rows[1]!.push(['津贴口径', '每人每次排班领取该班次设置的固定津贴，全部计入排班开始日期，跨夜只计一次。津贴与工资、工时、倍率及节假日无关。'])
  if (safe.rules.weekdayWeights) {
    const rule = safe.rules.weekdayWeights
    rows[1]!.push(['上班权重', `星期 ${rule.days.join('、')} 合计 ${rule.percent}%；按实际班次数核对，权重不替代每天每班的最少或固定人数要求，各组内每日差不超过 1 班。月首尾不足整周时，匹配完整周基准表示可满足比例的周总量，不表示月外已有这些排班。`], ['自然周起始', '本月首日', '本月末日', '本段实际班次', '选中星期实际班次', '其余星期实际班次', '匹配完整周基准', '班位缺口', '固定人数超额', '人数与权重检查', ...safe.shifts.map(s => s.name + '实际班次')])
    for (const week of weightedWeeks(safe)) {
      const assignments = safe.assignments.filter(item => week.dates.includes(item.date) && item.shiftId !== 'off')
      const selectedActual = assignments.filter(item => week.selectedDates.includes(item.date)).length
      const otherActual = assignments.length - selectedActual
      const matched = findWeightedWeek(safe, week, selectedActual, otherActual)
      const evenGroups = [week.selectedDates, week.otherDates].every(dates => {
        const counts = dates.map(date => assignments.filter(item => item.date === date).length)
        return counts.length < 2 || Math.max(...counts) - Math.min(...counts) <= 1
      })
      let minimumGap = 0, fixedGap = 0, fixedExcess = 0
      for (const date of week.dates) for (const shift of safe.shifts) {
        const count = assignments.filter(item => item.date === date && item.shiftId === shift.id).length
        const gap = Math.max(0, shift.required - count)
        if (shift.staffingMode === 'fixed') {
          fixedGap += gap
          fixedExcess += Math.max(0, count - shift.required)
        } else minimumGap += gap
      }
      const problems = [minimumGap ? '最低覆盖不足' : '', fixedGap ? '固定人数不足' : '', fixedExcess ? '固定人数超额' : '', !matched ? '星期比例未匹配' : '', !evenGroups ? '同组日期分布不均' : ''].filter(Boolean)
      rows[1]!.push([week.id, week.dates[0]!, week.dates.at(-1)!, assignments.length, selectedActual, otherActual, matched?.fullTotal ?? '未匹配', minimumGap + fixedGap, fixedExcess, problems.join('；') || '通过', ...safe.shifts.map(shift => assignments.filter(item => item.shiftId === shift.id).length)])
    }
  }
  if (rows.some(items => items.length > 100000 || items.some(row => row.length > 256))) throw new Error('Excel 导出数据量超出限制')
  if (rows.some(items => items.some(row => row.some(cell => typeof cell === 'number' ? !Number.isFinite(cell) : typeof cell !== 'string' || cell.length > 32767)))) throw new Error('Excel 单元格必须为有效文本或有限数字')
  const names = ['排班表', '班次说明', '津贴明细']
  const files: Record<string, Uint8Array> = {}
  const put = (name: string, text: string) => { files[name] = strToU8(text) }
  put('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${rows.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  put('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  put('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`)
  put('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  put('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF245B54"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
  rows.forEach((data, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheet(data)))
  return zipSync(files, { level: 6 })
}
