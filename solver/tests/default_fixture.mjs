import { makeDefaultState } from '../../src/defaults.ts'
const state = makeDefaultState('2026-10')
state.assignments = []
process.stdout.write(JSON.stringify(state))
