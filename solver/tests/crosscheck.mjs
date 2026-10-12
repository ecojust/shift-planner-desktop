// Run the existing independent TypeScript validator against CP-SAT solutions.
import { readFileSync } from 'node:fs'
import { validateSchedule } from '../../src/scheduler.ts'
const { state, assignments } = JSON.parse(readFileSync(0, 'utf8'))
process.stdout.write(JSON.stringify(validateSchedule({ ...state, assignments })))
