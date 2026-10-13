import { makeDefaultState } from '../../src/defaults.ts'
import { resolveHoursState } from '../../src/hours.ts'
const state = makeDefaultState('2026-10')
state.assignments = []
if (!process.argv.includes('--reference')) {
  // Keep the original coverage / rest / fairness regression feasible. The
  // reference-minimum mode below separately tests the new default's capacity.
  state.employees = state.employees.map(employee => ({ ...employee, minHoursPerMonth: 0, minHoursPerWeek: 0 }))
}
process.stdout.write(JSON.stringify(resolveHoursState(state)))
