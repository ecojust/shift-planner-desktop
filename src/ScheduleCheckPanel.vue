<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import type { Issue } from './domain.ts'
import type { ScheduleCheckEvent } from './scheduleCheckRunner.ts'
import { formatUserIssue, formatUserMessage } from './DesktopSolver.ts'
import { diagnosticActionLabel, withSolverGuidance } from './solverGuidance.ts'

const props = defineProps<{ month: string; check: ScheduleCheckEvent | null; hasSchedule: boolean }>()
const emit = defineEmits<{ retry: []; openIssue: [issue: Issue] }>()
const expanded = ref(false)
// Never display a previous month's result while its replacement is starting.
const current = computed(() => props.check?.month === props.month ? props.check : null)
const status = computed(() => {
  const check = current.value
  if (!check || check.status === 'checking') return 'checking'
  if (check.status === 'error') return 'error'
  return check.result.status === 'compliant' && !props.hasSchedule ? 'empty' : check.result.status
})
const titles = {
  checking: '正在检查排班规则…', compliant: '符合规则', noncompliant: '不符合规则',
  pending: '跨月规则待核对', empty: '尚未排班', error: '检查未完成',
} as const
const monthLabel = computed(() => {
  const match = /^(\d{4})-(\d{2})$/.exec(props.month)
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : props.month
})
const issues = computed(() => current.value?.status === 'ready'
  ? withSolverGuidance(current.value.result.issues).map(formatUserIssue) : [])
const visibleIssues = computed(() => expanded.value ? issues.value : issues.value.slice(0, 5))
const errorMessage = computed(() => current.value?.status === 'error' ? formatUserMessage(current.value.message) : '')
watch([() => props.month, () => props.check], () => { expanded.value = false })
</script>

<template>
  <section class="sp-schedule-check" :data-check-status="status" aria-label="排班规则检查" :aria-busy="status === 'checking'">
    <div class="sp-schedule-check-heading">
      <span v-if="status === 'checking'" class="sp-schedule-check-spinner" aria-hidden="true"></span>
      <Icon v-else :name="status === 'compliant' ? 'shield' : status === 'empty' ? 'calendar' : 'info'" :size="18" />
      <div class="sp-schedule-check-title" role="status" aria-live="polite" aria-atomic="true">
        <strong>{{ titles[status] }}</strong>
        <time :datetime="month">{{ monthLabel }}</time>
      </div>
      <button v-if="status === 'error'" type="button" class="sp-schedule-check-retry" @click="emit('retry')">重试检查</button>
    </div>
    <p v-if="status === 'empty'" class="sp-schedule-check-description">本月尚无排班记录。</p>
    <p v-else-if="status === 'error'" class="sp-schedule-check-description">{{ errorMessage }}</p>
    <ol v-if="issues.length" class="sp-schedule-check-issues">
      <li v-for="(issue, index) in visibleIssues" :key="`${issue.id}-${index}`">
        <span>{{ issue.message }}</span>
        <button v-if="diagnosticActionLabel(issue)" type="button" class="sp-schedule-check-action" :title="issue.suggestion" @click="emit('openIssue', issue)">{{ diagnosticActionLabel(issue) }} <span aria-hidden="true">→</span></button>
        <button v-else-if="issue.date" type="button" class="sp-schedule-check-action" @click="emit('openIssue', issue)">查看 {{ issue.date }} <span aria-hidden="true">→</span></button>
      </li>
    </ol>
    <button v-if="issues.length > 5" type="button" class="sp-schedule-check-expand" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? '收起部分原因' : `展开其余 ${issues.length - 5} 项原因` }}</button>
  </section>
</template>

<style scoped>
.sp-schedule-check { min-width: 0; margin-bottom: 12px; padding: 11px 14px; border: 1px solid #dfe6e2; border-radius: 10px; background: #f8faf9; color: #52665a; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.sp-schedule-check-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sp-schedule-check-heading > svg { flex-shrink: 0; }
.sp-schedule-check-title { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.sp-schedule-check-title strong { font-size: 13px; font-weight: 650; }
.sp-schedule-check-title time { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .85; white-space: nowrap; }
.sp-schedule-check[data-check-status="compliant"] { border-color: #d7e7dd; background: #f2f8f4; color: #28704c; }
.sp-schedule-check[data-check-status="noncompliant"],
.sp-schedule-check[data-check-status="error"] { border-color: #eed7d1; background: #fff7f5; color: #9a4438; }
.sp-schedule-check[data-check-status="pending"] { border-color: #eddfc2; background: #fffbf3; color: #8b642c; }
.sp-schedule-check[data-check-status="empty"] { border-color: #e1e5e3; background: #fafbfa; color: #6a7770; }
.sp-schedule-check-description { margin: 5px 0 0 26px; }
.sp-schedule-check-issues { display: grid; gap: 5px; margin: 7px 0 0 26px; padding-left: 17px; }
.sp-schedule-check-issues li { padding-left: 1px; }
.sp-schedule-check-action, .sp-schedule-check-expand, .sp-schedule-check-retry { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.sp-schedule-check-action { margin-left: 7px; padding: 0; text-decoration: underline; text-decoration-color: currentColor; text-underline-offset: 3px; white-space: nowrap; }
.sp-schedule-check-expand { margin: 7px 0 0 26px; padding: 0; font-weight: 600; }
.sp-schedule-check-retry { flex-shrink: 0; padding: 3px 8px; border: 1px solid currentColor; border-radius: 5px; font-weight: 600; }
.sp-schedule-check-action:hover, .sp-schedule-check-expand:hover, .sp-schedule-check-retry:hover { text-decoration: underline; text-underline-offset: 3px; }
.sp-schedule-check button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 3px; }
.sp-schedule-check-spinner { display: block; flex-shrink: 0; box-sizing: border-box; width: 17px; height: 17px; border: 2px solid #d9e4de; border-top-color: #47836a; border-radius: 50%; animation: sp-check-spin .8s linear infinite; }
@keyframes sp-check-spin { to { transform: rotate(360deg); } }
@media (max-width: 480px) {
  .sp-schedule-check { padding: 10px; }
  .sp-schedule-check-title { column-gap: 7px; }
  .sp-schedule-check-issues { margin-left: 8px; }
  .sp-schedule-check-description, .sp-schedule-check-expand { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .sp-schedule-check-spinner { animation: none; }
}
</style>
