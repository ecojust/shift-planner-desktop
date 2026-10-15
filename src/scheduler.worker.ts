import { generateSchedule } from './scheduler'
self.onmessage = (event) => {
  try {
    const { state, seed, requestId } = event.data
    const result = generateSchedule(state, seed, solutionCount => {
      self.postMessage({ progress: { requestId, phase: 'solving', solutionCount } })
    })
    self.postMessage({ result })
  }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '排班失败，请检查规则' }) }
}
