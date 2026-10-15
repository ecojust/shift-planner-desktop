import { makeDefaultState } from '../../src/defaults.ts'
import { createSolverRequest } from '../../src/solverDebug.ts'
const state = makeDefaultState('2026-10')
state.assignments = []
if (!process.argv.includes('--reference')) {
  // Keep the original coverage / rest / fairness regression feasible. The
  // reference mode below separately tests the application's current defaults.
  state.employees = state.employees.map(employee => ({ ...employee, minHoursPerWeek: 0 }))
}
process.stdout.write(JSON.stringify(createSolverRequest(state, { timeLimitSeconds: 3, seed: 1010, allowPartial: false }, 'default-fixture').state))
