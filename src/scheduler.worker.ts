import { generateSchedule } from './scheduler'
self.onmessage = (event) => {
  try { self.postMessage({ result: generateSchedule(event.data.state, event.data.seed) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '排班失败，请检查规则' }) }
}
