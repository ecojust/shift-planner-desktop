import { checkSchedule, type ScheduleCheckRequest, type ScheduleCheckResponse } from './scheduleCheck.ts'

self.onmessage = (event: MessageEvent<ScheduleCheckRequest>) => {
  const { requestId, month, referenceDate, state } = event.data
  let response: ScheduleCheckResponse
  try {
    if (state.month !== month) throw new Error('检查月份与排班数据不一致，请重新检查。')
    response = { requestId, month, result: checkSchedule(state, { referenceDate }) }
  } catch (error) {
    response = { requestId, month, error: error instanceof Error ? error.message : '规则检查失败，请重试。' }
  }
  self.postMessage(response)
}
