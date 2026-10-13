import type { PlannerState } from './domain.ts'
import { generateSchedule } from './scheduler.ts'

export function makeDefaultState(month?: string): PlannerState {
  const today = new Date()
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const names = ['陈晨', '林晚晴', '周予安', '许知夏', '江远', '沈一诺', '陆星遥', '顾南风', '宋宁', '唐悦', '苏念', '程屿']
  const colors = ['#d7e8f8', '#f7dbd0', '#e4def5', '#d9eddf', '#f5e8c9', '#d9e7ed']
  const state: PlannerState = {
    version: 1,
    teamName: '我的排班',
    month: month || currentMonth,
    employees: names.map((name, index) => ({
      id: `employee-${index + 1}`,
      name,
      role: index < 2 ? '值班主管' : '服务专员',
      group: index < 6 ? '一组' : '二组',
      color: colors[index % colors.length]!,
      maxHoursPerWeek: 40,
      eligibleShiftIds: index < 8 ? ['morning', 'evening', 'night'] : ['morning', 'evening'],
      unavailableDates: [],
    })),
    shifts: [
      { id: 'morning', name: '早班', shortName: '早', start: '08:00', end: '16:00', color: '#dbeee6', required: 2 },
      { id: 'evening', name: '晚班', shortName: '晚', start: '14:00', end: '22:00', color: '#e5def7', required: 2 },
      { id: 'night', name: '夜班', shortName: '夜', start: '22:00', end: '06:00', color: '#dce8fa', required: 1 },
    ],
    rules: { minRestHours: 11, maxConsecutiveDays: 5 },
    assignments: [],
  }
  state.assignments = generateSchedule(state).assignments
  // Retain the illustrative roster; new minimums may reveal genuine deficits.
  // The initial demo covers daily minimums; generating later may add staff to
  // satisfy the reference-linked minimum hours.
  state.employees = state.employees.map(employee => ({ ...employee, minHoursPerMonth: null, minHoursPerWeek: 0 }))
  return state
}
