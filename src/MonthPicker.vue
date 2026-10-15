<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

type ScheduleStatus = 'empty' | 'scheduled' | 'invalid' | 'pending' | 'conflict' | 'checking'
type ScheduleStatusEntry = ScheduleStatus | { status: ScheduleStatus; description?: string }
const props = defineProps<{ modelValue: string; scheduleStatuses?: Readonly<Record<string, ScheduleStatusEntry>>; getScheduleStatus?: (month: string) => ScheduleStatusEntry }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; 'visible-months': [months: string[]] }>()
const id = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const visible = ref(false)
const mode = ref<'months' | 'years'>('months')
const selectedYear = computed(() => Number(props.modelValue.slice(0, 4)))
const selectedMonth = computed(() => Number(props.modelValue.slice(5)))
const year = ref(selectedYear.value)
const focusedMonth = ref(selectedMonth.value)
const focusedYear = ref(selectedYear.value)
const yearPage = ref(Math.floor((selectedYear.value - 1) / 12) * 12 + 1)
const months = Array.from({ length: 12 }, (_, index) => index + 1)
const years = computed(() => Array.from({ length: Math.min(12, 10000 - yearPage.value) }, (_, index) => yearPage.value + index))
const position = ref({ left: '12px', top: '12px' })
const formattedYear = (value: number) => String(value).padStart(4, '0')
const title = computed(() => `${formattedYear(selectedYear.value)} 年 ${selectedMonth.value} 月`)
const statusLabels: Record<ScheduleStatus, string> = { empty: '未排班', scheduled: '已排班', invalid: '规则已修改，排班已失效', pending: '已排班 · 跨月待核对', conflict: '不符合规则', checking: '正在检查' }
function statusInfo(value: string) {
  const entry = props.getScheduleStatus?.(value) ?? props.scheduleStatuses?.[value]
  const status = typeof entry === 'string' ? entry : entry?.status ?? 'empty'
  const label = statusLabels[status]
  const detail = typeof entry === 'object' ? entry.description : undefined
  return { status, label, description: detail ? detail.startsWith(label) ? detail : `${label}。${detail}` : label }
}
const selectedInfo = computed(() => statusInfo(props.modelValue))
const monthChoices = computed(() => months.map(month => {
  const value = `${formattedYear(year.value)}-${String(month).padStart(2, '0')}`
  return { month, ...statusInfo(value) }
}))
watch([visible, year, mode], () => emit('visible-months', visible.value && mode.value === 'months'
  ? months.map(month => `${formattedYear(year.value)}-${String(month).padStart(2, '0')}`) : []))

function positionPanel() {
  if (!visible.value || !trigger.value || !panel.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const box = panel.value.getBoundingClientRect()
  const below = anchor.bottom + 8
  const top = below + box.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - box.height - 8)
  position.value = {
    left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12))}px`,
    top: `${Math.max(12, Math.min(top, window.innerHeight - box.height - 12))}px`,
  }
}
async function focusChoice() {
  await nextTick()
  if (!visible.value) return
  positionPanel()
  const choice = panel.value?.querySelector<HTMLButtonElement>(mode.value === 'months' ? `[data-month="${focusedMonth.value}"]` : `[data-year="${focusedYear.value}"]`)
  choice?.focus({ preventScroll: true })
  // Only scroll the grid: scrolling the page would dismiss this popover and
  // leave a keyboard user unable to reach months below a short viewport.
  const grid = choice?.parentElement
  if (choice && grid) {
    const button = choice.getBoundingClientRect(), bounds = grid.getBoundingClientRect()
    if (button.bottom > bounds.bottom - 3) grid.scrollTop += button.bottom - bounds.bottom + 3
    else if (button.top < bounds.top + 3) grid.scrollTop -= bounds.top - button.top + 3
  }
}
function open() {
  year.value = selectedYear.value
  focusedMonth.value = selectedMonth.value
  mode.value = 'months'
  visible.value = true
  void focusChoice()
}
function close(restoreFocus = true) {
  visible.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}
function chooseMonth(month: number) {
  emit('update:modelValue', `${formattedYear(year.value)}-${String(month).padStart(2, '0')}`)
  close()
}
function changeYear(direction: number) {
  year.value = Math.min(9999, Math.max(1, year.value + direction))
}
function showYears() {
  focusedYear.value = year.value
  yearPage.value = Math.floor((year.value - 1) / 12) * 12 + 1
  mode.value = 'years'
  void focusChoice()
}
function showMonths(value = year.value) {
  year.value = value
  mode.value = 'months'
  void focusChoice()
}
function changeYearPage(direction: number) {
  const next = yearPage.value + direction * 12
  if (next < 1 || next > 9999) return
  const offset = focusedYear.value - yearPage.value
  yearPage.value = next
  focusedYear.value = Math.min(9999, next + offset)
}
function monthKey(event: KeyboardEvent, month: number) {
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 }[event.key]
  if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const index = Math.min(9999 * 12 - 1, Math.max(0, (year.value - 1) * 12 + month - 1 + (delta ?? 0)))
  year.value = Math.floor(index / 12) + 1
  focusedMonth.value = event.key === 'Home' ? 1 : event.key === 'End' ? 12 : index % 12 + 1
  void focusChoice()
}
function yearKey(event: KeyboardEvent, value: number) {
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 }[event.key]
  if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  focusedYear.value = event.key === 'Home' ? yearPage.value : event.key === 'End' ? years.value.at(-1)! : Math.min(9999, Math.max(1, value + (delta ?? 0)))
  yearPage.value = Math.floor((focusedYear.value - 1) / 12) * 12 + 1
  void focusChoice()
}
function panelKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if (event.key === 'Tab') {
    const buttons = [...panel.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([tabindex="-1"])')]
    const first = buttons[0]
    const last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function outside(event: Event) {
  if (visible.value && !trigger.value?.contains(event.target as Node) && !panel.value?.contains(event.target as Node)) close(false)
}
function scrolled(event: Event) {
  if (visible.value && !panel.value?.contains(event.target as Node)) close()
}
watch(() => props.modelValue, () => { if (visible.value) close(false) })
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('scroll', scrolled, true)
  window.addEventListener('resize', positionPanel)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('scroll', scrolled, true)
  window.removeEventListener('resize', positionPanel)
})
</script>

<template>
  <div class="sp-month-picker">
    <span class="sp-month-picker-label">排班月份</span>
    <button ref="trigger" type="button" class="sp-month-picker-trigger" aria-label="全局排班月份" :aria-describedby="`${id}-value ${id}-status`" :data-schedule-status="selectedInfo.status" :title="selectedInfo.description" aria-haspopup="dialog" :aria-expanded="visible" :aria-controls="visible ? id : undefined" @click="visible ? close() : open()" @keydown.down.prevent="open">
      <span :id="`${id}-value`">{{ title }}</span><Icon name="calendar" :size="16" />
      <span :id="`${id}-status`" class="sp-month-picker-sr-only">{{ selectedInfo.description }}</span>
    </button>
  </div>
  <Teleport to="body">
    <section v-if="visible" :id="id" ref="panel" class="sp-month-picker-panel" role="dialog" aria-label="选择排班月份" :style="position" @keydown="panelKey">
      <header class="sp-month-picker-heading">
        <button type="button" class="sp-icon-button" :aria-label="mode === 'months' ? '上一年' : '上一组年份'" :disabled="mode === 'months' ? year === 1 : yearPage === 1" @click="mode === 'months' ? changeYear(-1) : changeYearPage(-1)"><Icon class="sp-flip" name="arrow" :size="16" /></button>
        <button type="button" class="sp-month-picker-heading-title" :aria-label="mode === 'months' ? '选择年份' : '返回月份选择'" @click="mode === 'months' ? showYears() : showMonths()"><span aria-live="polite">{{ mode === 'months' ? `${formattedYear(year)} 年` : `${formattedYear(yearPage)} — ${formattedYear(years.at(-1)!)}` }}</span><Icon class="sp-month-picker-caret" name="arrow" :size="14" /></button>
        <button type="button" class="sp-icon-button" :aria-label="mode === 'months' ? '下一年' : '下一组年份'" :disabled="mode === 'months' ? year === 9999 : yearPage + 12 > 9999" @click="mode === 'months' ? changeYear(1) : changeYearPage(1)"><Icon name="arrow" :size="16" /></button>
      </header>
      <div v-if="mode === 'months'" class="sp-month-picker-grid" role="group" :aria-label="`${year} 年的月份`">
        <button v-for="choice in monthChoices" :key="choice.month" type="button" class="sp-month-picker-choice" :data-month="choice.month" :data-schedule-status="choice.status" :tabindex="choice.month === focusedMonth ? 0 : -1" :aria-label="`${year} 年 ${choice.month} 月`" :aria-describedby="`${id}-month-${choice.month}-status`" :title="choice.description" :aria-pressed="year === selectedYear && choice.month === selectedMonth" @focus="focusedMonth = choice.month" @keydown="monthKey($event, choice.month)" @click="chooseMonth(choice.month)">
          <span class="sp-month-picker-name">{{ choice.month }} 月</span>
          <span class="sp-month-picker-status" :class="`is-${choice.status}`" aria-hidden="true"><Icon :name="choice.status === 'checking' ? 'clock' : ['invalid', 'pending', 'conflict'].includes(choice.status) ? 'info' : choice.status === 'scheduled' ? 'check' : 'calendar'" :size="12" /><span class="sp-month-picker-status-copy"><template v-if="choice.status === 'invalid'"><span>规则已修改</span><span>排班已失效</span></template><template v-else-if="choice.status === 'pending'"><span>已排班</span><span>跨月待核对</span></template><template v-else-if="choice.status === 'conflict'"><span>不符合规则</span><span>查看具体原因</span></template><span v-else>{{ choice.label }}</span></span></span>
          <span :id="`${id}-month-${choice.month}-status`" class="sp-month-picker-sr-only">{{ choice.description }}</span>
        </button>
      </div>
      <div v-else class="sp-month-picker-grid" role="group" aria-label="年份">
        <button v-for="value in years" :key="value" type="button" :data-year="value" :tabindex="value === focusedYear ? 0 : -1" :aria-label="`${value} 年`" :aria-pressed="value === year" @focus="focusedYear = value" @keydown="yearKey($event, value)" @click="showMonths(value)">{{ formattedYear(value) }}</button>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.sp-month-picker { display: flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; }
.sp-month-picker-label { font-size: 11px; color: #65786e; }
.sp-month-picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 145px; min-height: 40px; padding: 7px 9px; border: 1px solid #d9e2da; border-radius: 6px; background: #f8faf8; color: #245b4e; font-weight: 600; font-size: 13px; font-variant-numeric: tabular-nums; }
.sp-month-picker-trigger:hover, .sp-month-picker-trigger[aria-expanded="true"] { background: #edf4f0; border-color: #a3bdb0; }
.sp-month-picker-trigger svg { color: #657e70; }
.sp-month-picker-panel { position: fixed; z-index: 1100; display: flex; flex-direction: column; box-sizing: border-box; width: min(300px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: hidden; padding: 12px; border: 1px solid #dce5df; border-radius: 10px; background: #fff; color: #233b33; box-shadow: 0 6px 24px #173d2826; font-size: 13px; line-height: 1.5; }
.sp-month-picker-heading { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 10px; }
.sp-month-picker-heading .sp-icon-button { flex-shrink: 0; width: 40px; height: 40px; }
.sp-month-picker-heading-title { display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1; min-height: 40px; padding: 4px; border: 0; border-radius: 6px; background: transparent; color: #245b4e; font-weight: 600; font-variant-numeric: tabular-nums; }
.sp-month-picker-heading-title:hover { background: #edf4f0; }
.sp-month-picker-caret { transform: rotate(90deg); }
.sp-month-picker-grid { display: grid; min-height: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: -3px; padding: 3px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #b6c9be transparent; }
.sp-month-picker-grid::-webkit-scrollbar { width: 5px; }
.sp-month-picker-grid::-webkit-scrollbar-thumb { border-radius: 4px; background: #b6c9be; }
.sp-month-picker-grid button { min-height: 44px; border: 1px solid transparent; border-radius: 6px; padding: 8px 4px; background: #f7f9f7; color: #486052; font-variant-numeric: tabular-nums; }
.sp-month-picker-grid button:focus-visible { outline: 2px solid #33775d; outline-offset: 1px; }
.sp-month-picker-grid button:hover { background: #e8f1eb; }
.sp-month-picker-grid .sp-month-picker-choice { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-width: 0; min-height: 72px; padding: 6px 3px; }
.sp-month-picker-name { font-size: 13px; font-weight: 600; }
.sp-month-picker-status { display: flex; align-items: center; justify-content: center; gap: 3px; min-height: 28px; max-width: 100%; color: #7b8b80; font-size: 10px; font-weight: 500; line-height: 14px; }
.sp-month-picker-status svg { flex-shrink: 0; }
.sp-month-picker-status-copy { display: flex; flex-direction: column; align-items: center; white-space: nowrap; }
.sp-month-picker-status.is-scheduled { color: #28745a; }
.sp-month-picker-status.is-invalid { color: #91591b; }
.sp-month-picker-status.is-pending { color: #586b96; }
.sp-month-picker-status.is-conflict { color: #a54336; }
.sp-month-picker-choice[data-schedule-status="scheduled"] { background: #f0f7f2; border-color: #dfebe3; }
.sp-month-picker-choice[data-schedule-status="invalid"] { background: #fff7e9; border-color: #eedcbd; }
.sp-month-picker-choice[data-schedule-status="invalid"]:hover { background: #ffefd5; }
.sp-month-picker-choice[data-schedule-status="pending"] { background: #f1f4fa; border-color: #dde3f0; }
.sp-month-picker-choice[data-schedule-status="pending"]:hover { background: #e8edf7; }
.sp-month-picker-choice[data-schedule-status="conflict"] { background: #fff1ee; border-color: #f1d7d0; }
.sp-month-picker-choice[data-schedule-status="conflict"]:hover { background: #ffe7df; }
.sp-month-picker-grid button[aria-pressed="true"] { background: #245b4e; color: #fff; font-weight: 600; }
.sp-month-picker-choice[aria-pressed="true"] .sp-month-picker-status { color: #e4f4e9; }
.sp-month-picker-choice[aria-pressed="true"] .sp-month-picker-status.is-invalid { color: #ffe4a7; }
.sp-month-picker-choice[aria-pressed="true"] .sp-month-picker-status.is-pending { color: #e0e8ff; }
.sp-month-picker-choice[aria-pressed="true"] .sp-month-picker-status.is-conflict { color: #ffddd0; }
.sp-month-picker-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  .sp-month-picker { gap: 6px; }
  .sp-month-picker-label { font-size: 10px; }
  .sp-month-picker-trigger { min-width: 155px; min-height: 44px; }
}
@media (max-width: 400px) { .sp-month-picker-label { display: none; } }
</style>
