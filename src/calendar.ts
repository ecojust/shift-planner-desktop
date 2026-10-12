import { HolidayUtil, Lunar } from 'lunar-typescript'

export type DayKind = 'workday' | 'restday' | 'statutory'
export interface DayInfo { kind: DayKind; label: string; source: string; verified: boolean }
export interface CalendarYearInfo { verified: boolean; reason: string; source: string }

export const HOLIDAY_SOURCE = 'https://github.com/6tail/lunar-typescript'
export const STATUTORY_SOURCE = 'https://www.gov.cn/zhengce/content/202411/content_6986380.htm'
const source = `lunar-typescript / HolidayUtil：${HOLIDAY_SOURCE}；法定日依据：${STATUTORY_SOURCE}`
const labels: Record<DayKind, string> = { workday: '工作日', restday: '休息日', statutory: '法定节假日' }
const requiredFestivals = ['元旦', '春节', '清明', '劳动', '端午', '中秋', '国庆']
const years = new Map<number, { info: CalendarYearInfo; statutory: Map<string, string> }>()

export function isCivilDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date
}

/** Statutory paid dates are not the same as HolidayUtil's entire holiday period.
 * This policy starts in 2025: Spring Festival adds its eve and Labour Day adds May 2.
 * Lunar supplies civil dates and Qingming; folk festivals never imply statutory pay.
 */
function statutoryDates(year: number): Map<string, string> {
  const spring = Lunar.fromYmd(year, 1, 1).getSolar()
  const qingming = spring.getLunar().getJieQiTable()['清明']
  const entries: Array<[string, string]> = [
    [`${year}-01-01`, '元旦'],
    [spring.next(-1).toYmd(), '春节·除夕'],
    [spring.toYmd(), '春节·初一'],
    [spring.next(1).toYmd(), '春节·初二'],
    [spring.next(2).toYmd(), '春节·初三'],
    [qingming.toYmd(), '清明节'],
    [`${year}-05-01`, '劳动节'], [`${year}-05-02`, '劳动节'],
    [Lunar.fromYmd(year, 5, 5).getSolar().toYmd(), '端午节'],
    [Lunar.fromYmd(year, 8, 15).getSolar().toYmd(), '中秋节'],
    [`${year}-10-01`, '国庆节'], [`${year}-10-02`, '国庆节'], [`${year}-10-03`, '国庆节'],
  ]
  return new Map(entries)
}

function yearCalendar(year: number) {
  const cached = years.get(year)
  if (cached) return cached
  const statutory = new Map<string, string>()
  let reason = ''
  if (!Number.isInteger(year) || year < 2025 || year > 9999) {
    reason = '当前自动计薪日历采用 2025 年起的法定制度；历史年份须另行核对。'
  } else {
    // A previous December can contain only next year's New Year adjustments.
    // Check all seven festival groups targeted at this year, not merely any record.
    const holidays = HolidayUtil.getHolidays(year)
    const names = holidays.filter(holiday => holiday.getTarget().startsWith(`${year}-`)).map(holiday => holiday.getName())
    if (!requiredFestivals.every(name => names.some(candidate => candidate.includes(name)))) {
      reason = '当前 lunar-typescript 数据未覆盖该年完整放假与补班安排。'
    } else {
      const dates = statutoryDates(year)
      if (dates.size !== 13) {
        reason = '该年法定节日发生重合，补假及计薪日期需另行核对。'
      } else if ([...dates.keys()].some(date => !HolidayUtil.getHoliday(date) || HolidayUtil.getHoliday(date)!.isWork())) {
        reason = '法定日期与库内放假安排未完整对应，请核对该年日历。'
      } else {
        for (const [date, name] of dates) statutory.set(date, name)
      }
    }
  }
  const result = { info: { verified: !reason, reason, source }, statutory }
  years.set(year, result)
  return result
}

export function calendarYearInfo(year: number): CalendarYearInfo { return { ...yearCalendar(year).info } }

/** Overrides retain their original storage format and always win, including future years. */
export function dayInfo(date: string, overrides: Record<string, DayKind> = {}): DayInfo {
  if (!isCivilDate(date)) return { kind: 'workday', label: '日期无效', source: '', verified: false }
  const custom = Object.hasOwn(overrides, date) ? overrides[date] : undefined
  if (custom && Object.hasOwn(labels, custom)) return { kind: custom, label: `${labels[custom]}·手动`, source: '用户自定义日历', verified: true }
  const calendar = yearCalendar(Number(date.slice(0, 4)))
  if (calendar.info.verified) {
    const statutory = calendar.statutory.get(date)
    if (statutory) return { kind: 'statutory', label: `${statutory}·法定`, source, verified: true }
    const holiday = HolidayUtil.getHoliday(date)
    if (holiday?.isWork()) return { kind: 'workday', label: '调休上班', source, verified: true }
    if (holiday) return { kind: 'restday', label: `${holiday.getName()}·调休/连休`, source, verified: true }
  }
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay()
  const kind: DayKind = weekday === 0 || weekday === 6 ? 'restday' : 'workday'
  return { kind, label: labels[kind] + (calendar.info.verified ? '' : '·待核对'),
    source: calendar.info.verified ? source : `${calendar.info.reason}暂按周一至周五/周末推算，请逐日确认或导入已有手动日历。`, verified: calendar.info.verified }
}
