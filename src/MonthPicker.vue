<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
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
  panel.value?.querySelector<HTMLButtonElement>(mode.value === 'months' ? `[data-month="${focusedMonth.value}"]` : `[data-year="${focusedYear.value}"]`)?.focus({ preventScroll: true })
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
    <button ref="trigger" type="button" class="sp-month-picker-trigger" aria-label="全局排班月份" :aria-describedby="`${id}-value`" aria-haspopup="dialog" :aria-expanded="visible" :aria-controls="visible ? id : undefined" @click="visible ? close() : open()" @keydown.down.prevent="open">
      <span :id="`${id}-value`">{{ title }}</span><Icon name="calendar" :size="16" />
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
        <button v-for="month in months" :key="month" type="button" :data-month="month" :tabindex="month === focusedMonth ? 0 : -1" :aria-label="`${year} 年 ${month} 月`" :aria-pressed="year === selectedYear && month === selectedMonth" @focus="focusedMonth = month" @keydown="monthKey($event, month)" @click="chooseMonth(month)">{{ month }} 月</button>
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
.sp-month-picker-panel { position: fixed; z-index: 1100; width: min(300px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; overscroll-behavior: contain; padding: 12px; border: 1px solid #dce5df; border-radius: 10px; background: #fff; color: #233b33; box-shadow: 0 6px 24px #173d2826; font-size: 13px; line-height: 1.5; }
.sp-month-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 10px; }
.sp-month-picker-heading .sp-icon-button { flex-shrink: 0; width: 40px; height: 40px; }
.sp-month-picker-heading-title { display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1; min-height: 40px; padding: 4px; border: 0; border-radius: 6px; background: transparent; color: #245b4e; font-weight: 600; font-variant-numeric: tabular-nums; }
.sp-month-picker-heading-title:hover { background: #edf4f0; }
.sp-month-picker-caret { transform: rotate(90deg); }
.sp-month-picker-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.sp-month-picker-grid button { min-height: 44px; border: 1px solid transparent; border-radius: 6px; padding: 8px 4px; background: #f7f9f7; color: #486052; font-variant-numeric: tabular-nums; }
.sp-month-picker-grid button:hover { background: #e8f1eb; }
.sp-month-picker-grid button[aria-pressed="true"] { background: #245b4e; color: #fff; font-weight: 600; }
@media (max-width: 760px) {
  .sp-month-picker { gap: 6px; }
  .sp-month-picker-label { font-size: 10px; }
  .sp-month-picker-trigger { min-width: 155px; min-height: 44px; }
}
@media (max-width: 400px) { .sp-month-picker-label { display: none; } }
</style>
