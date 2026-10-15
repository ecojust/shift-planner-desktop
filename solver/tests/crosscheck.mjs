// Run the existing independent TypeScript validator against CP-SAT solutions.
import { readFileSync } from 'node:fs'
import { validateBoundaryPreview } from '../../src/scheduler.ts'
const { state, assignments, boundaryPreview, referenceDate } = JSON.parse(readFileSync(0, 'utf8'))
// Validate the saved target month together with temporary boundary evidence.
// Coverage warnings remain failures; unknown-history notices are informational.
process.stdout.write(JSON.stringify(validateBoundaryPreview({ ...state, assignments }, boundaryPreview, referenceDate)))
