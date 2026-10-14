<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { Employee } from './domain.ts'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{ employee: Employee; initialMonth: string }>()
const emit = defineEmits<{ save: [dates: string[]]; close: [] }>()
const titleId = useId()
const descriptionId = useId()
const dialog = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const maxDates = 3660
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const error = ref('')

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1
}
function validDate(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value) || Number(value.slice(0, 4)) < 1) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
// ISO parsing preserves years 0001–0099; Date.UTC would remap them into the 1900s.
function civilDate(value: string) { return new Date(`${value}T00:00:00Z`) }
const initialMonth = validMonth(props.initialMonth) ? props.initialMonth : new Date().toISOString().slice(0, 7)
const month = ref(initialMonth)
const selected = ref(new Set(props.employee.unavailableDates))
const pendingRemoval = ref<{ kind: 'date'; date: string } | { kind: 'month'; month: string; count: number } | null>(null)
const focusedDate = ref(`${initialMonth}-01`)
const monthLabel = computed(() => `${Number(month.value.slice(0, 4))} 年 ${Number(month.value.slice(5))} 月`)
const firstWeekday = computed(() => (civilDate(`${month.value}-01`).getUTCDay() + 6) % 7)
const days = computed(() => {
  const date = civilDate(`${month.value}-01`)
  date.setUTCMonth(date.getUTCMonth() + 1, 0)
  return Array.from({ length: date.getUTCDate() }, (_, index) => `${month.value}-${String(index + 1).padStart(2, '0')}`)
})
const monthCount = computed(() => [...selected.value].filter(date => date.startsWith(`${month.value}-`)).length)
const otherMonthCount = computed(() => selected.value.size - monthCount.value)
const canPrevious = computed(() => month.value !== '0001-01')
const canNext = computed(() => month.value !== '9999-12')

function changeMonth(value: string) {
  if (!validMonth(value)) { error.value = '请选择有效的月份，年份为 0001–9999。'; return false }
  month.value = value
  focusedDate.value = `${value}-01`
  error.value = ''
  return true
}
function inputMonth(event: Event) {
  const input = event.target as HTMLInputElement
  if (!changeMonth(input.value)) input.value = month.value
}
function stepMonth(direction: number) {
  if ((direction < 0 && !canPrevious.value) || (direction > 0 && !canNext.value)) return
  const date = civilDate(`${month.value}-01`)
  date.setUTCMonth(date.getUTCMonth() + direction)
  changeMonth(date.toISOString().slice(0, 7))
}
function toggleDate(date: string) {
  focusedDate.value = date
  if (selected.value.has(date)) { pendingRemoval.value = { kind: 'date', date }; return }
  else {
    if (selected.value.size >= maxDates) { error.value = `每位成员累计最多设置 ${maxDates} 天请假，请先移除不再需要的日期。`; return }
    selected.value.add(date)
  }
  error.value = ''
}
function clearMonth() {
  if (monthCount.value) pendingRemoval.value = { kind: 'month', month: month.value, count: monthCount.value }
}
function confirmRemoval() {
  const pending = pendingRemoval.value
  pendingRemoval.value = null
  if (!pending) return
  if (pending.kind === 'date') {
    if (!selected.value.has(pending.date)) return
    selected.value = new Set([...selected.value].filter(date => date !== pending.date))
  } else {
    if (pending.month !== month.value || pending.count !== monthCount.value) return
    selected.value = new Set([...selected.value].filter(date => !date.startsWith(`${pending.month}-`)))
  }
  error.value = ''
}
const removalDescription = computed(() => {
  const pending = pendingRemoval.value
  if (!pending) return ''
  const change = pending.kind === 'date' ? `将取消 ${props.employee.name} 在 ${pending.date} 的请假。` : `将清空 ${props.employee.name} 在 ${Number(pending.month.slice(0, 4))} 年 ${Number(pending.month.slice(5))} 月的 ${pending.count} 天请假，保留其他月份。`
  return `${change}本次仅修改编辑内容，点击“保存请假”后才会生效；已有排班会保留。`
})
watch([selected, month, () => props.employee, () => props.initialMonth], () => { pendingRemoval.value = null }, { deep: true, flush: 'sync' })
function dateLabel(date: string) {
  const weekday = weekdays[(civilDate(date).getUTCDay() + 6) % 7]
  return `${date} 星期${weekday}，${selected.value.has(date) ? '已请假' : '未请假'}`
}
async function navigateDate(event: KeyboardEvent, value: string) {
  const offset: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  if (!Object.hasOwn(offset, event.key)) return
  event.preventDefault()
  const date = civilDate(value)
  date.setUTCDate(date.getUTCDate() + offset[event.key]!)
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return
  const nextDate = date.toISOString().slice(0, 10)
  if (nextDate.slice(0, 7) !== month.value) changeMonth(nextDate.slice(0, 7))
  focusedDate.value = nextDate
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>(`[data-leave-date="${nextDate}"]`)?.focus()
}
function save() {
  if (pendingRemoval.value) return
  const dates = [...selected.value].sort()
  if (dates.length > maxDates || dates.some(date => !validDate(date))) {
    error.value = `请假日期必须为有效日期，累计最多 ${maxDates} 天。`
    return
  }
  emit('save', dates)
}

let opener: HTMLElement | null = null
let previousOverflow = ''
let mounted = false
function focusableElements() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]') ?? [])]
    .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]'))
}
function onKeydown(event: KeyboardEvent) {
  if (pendingRemoval.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  // Keep this dialog's tab order independent of the application's other dialogs.
  event.stopPropagation()
  const elements = focusableElements()
  const first = elements[0], last = elements[elements.length - 1]
  if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault(); first.focus()
  }
}
function containFocus(event: FocusEvent) {
  if (!pendingRemoval.value && mounted && dialog.value && !dialog.value.contains(event.target as Node)) closeButton.value?.focus()
}
onMounted(() => {
  mounted = true
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', containFocus)
  closeButton.value?.focus()
})
onBeforeUnmount(() => {
  mounted = false
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('focusin', containFocus)
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow
  const returnTarget = opener
  nextTick(() => { if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true }) })
})
</script>

<template>
  <Teleport to="body">
    <div class="sp-leave-backdrop" @click.self="!pendingRemoval && emit('close')">
      <section ref="dialog" class="sp-leave-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" :inert="!!pendingRemoval" :aria-hidden="pendingRemoval ? true : undefined" tabindex="-1">
        <header class="sp-leave-heading">
          <div><h2 :id="titleId">{{ employee.name }} · 请假日历</h2><p :id="descriptionId">点击日期设置全天请假，再次点击并确认后取消。</p></div>
          <button ref="closeButton" type="button" class="sp-leave-icon-button" aria-label="关闭请假日历" @click="emit('close')"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </header>

        <div class="sp-leave-content">
          <div class="sp-leave-month-nav">
            <button type="button" class="sp-leave-icon-button" aria-label="上个月" :disabled="!canPrevious" @click="stepMonth(-1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button>
            <label class="sp-leave-month-field"><span class="sp-leave-sr-only">请假月份</span><input type="month" aria-label="请假月份" min="0001-01" max="9999-12" :value="month" @change="inputMonth" /></label>
            <button type="button" class="sp-leave-icon-button" aria-label="下个月" :disabled="!canNext" @click="stepMonth(1)"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button>
          </div>

          <div class="sp-leave-weekdays" aria-hidden="true"><span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span></div>
          <div class="sp-leave-days" role="group" :aria-label="`${monthLabel}请假日期`">
            <span v-for="blank in firstWeekday" :key="`blank-${blank}`" aria-hidden="true"></span>
            <button v-for="date in days" :key="date" type="button" class="sp-leave-day" :class="{ 'is-selected': selected.has(date) }" :data-leave-date="date" :aria-label="dateLabel(date)" :aria-pressed="selected.has(date)" :tabindex="focusedDate === date ? 0 : -1" @click="toggleDate(date)" @focus="focusedDate = date" @keydown="navigateDate($event, date)">
              <span>{{ Number(date.slice(-2)) }}</span><span class="sp-leave-day-mark" aria-hidden="true">{{ selected.has(date) ? '休' : '' }}</span>
            </button>
          </div>

          <div class="sp-leave-summary">
            <p aria-live="polite">本月 <strong>{{ monthCount }}</strong> 天<span>累计 {{ selected.size }} 天</span></p>
            <button type="button" class="sp-leave-clear" :disabled="monthCount === 0" @click="clearMonth">清空本月</button>
          </div>
          <p class="sp-leave-hint">{{ otherMonthCount ? `其他月份的 ${otherMonthCount} 天请假会一并保留。` : '切换月份可继续选择，保存后统一生效。' }}已有排班会保留，请按冲突提示调整。</p>
          <p v-if="error" class="sp-leave-error" role="alert">{{ error }}</p>
        </div>

        <footer class="sp-leave-actions"><button type="button" class="sp-leave-button" @click="emit('close')">取消</button><button type="button" class="sp-leave-button is-primary" @click="save">保存请假</button></footer>
      </section>
    </div>
  </Teleport>
  <ConfirmDialog v-if="pendingRemoval" :title="pendingRemoval.kind === 'date' ? '取消该日请假？' : '清空本月请假？'" :description="removalDescription" :confirm-label="pendingRemoval.kind === 'date' ? '确认取消请假' : '确认清空'" cancel-label="保留请假" @confirm="confirmRemoval" @cancel="pendingRemoval = null" />
</template>

<style scoped>
.sp-leave-backdrop { position: fixed; z-index: 1200; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: #162d286b; color: #233730; }
.sp-leave-dialog { width: 440px; max-width: 100%; max-height: calc(100dvh - 40px); display: flex; flex-direction: column; overflow: hidden; background: #fff; border: 1px solid #dce4df; border-radius: 12px; font-size: 14px; line-height: 1.5; box-shadow: 0 16px 56px #162d2826; }
.sp-leave-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 18px 16px 14px 20px; border-bottom: 1px solid #e5eae6; flex-shrink: 0; }
.sp-leave-heading > div { min-width: 0; }
.sp-leave-heading h2 { margin: 0; font-size: 18px; font-weight: 650; overflow-wrap: anywhere; }
.sp-leave-heading p { margin: 5px 0 0; font-size: 12px; color: #6d7f73; }
.sp-leave-dialog button, .sp-leave-dialog input { font: inherit; color: inherit; box-sizing: border-box; }
.sp-leave-dialog button { cursor: pointer; touch-action: manipulation; }
.sp-leave-dialog button:disabled { cursor: default; opacity: .4; }
.sp-leave-dialog button:focus-visible, .sp-leave-dialog input:focus-visible { outline: 2px solid #276a56; outline-offset: 2px; }
.sp-leave-icon-button { width: 44px; height: 44px; flex-shrink: 0; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 7px; background: transparent; }
.sp-leave-icon-button:hover:not(:disabled) { background: #f0f5f1; }
.sp-leave-icon-button svg { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.sp-leave-content { min-height: 0; overflow: auto; padding: 14px 20px 18px; overscroll-behavior: contain; }
.sp-leave-month-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.sp-leave-month-field { flex: 1; min-width: 0; }
.sp-leave-month-field input { display: block; width: 100%; min-width: 0; height: 44px; padding: 0 8px; border: 1px solid #d9e2da; border-radius: 7px; background: #fff; text-align: center; font-size: 15px; font-weight: 550; }
.sp-leave-weekdays, .sp-leave-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.sp-leave-weekdays { margin-bottom: 6px; text-align: center; color: #6d7f73; font-size: 12px; }
.sp-leave-weekdays span { padding: 5px 0; }
.sp-leave-day { min-width: 0; min-height: 48px; padding: 4px 0 3px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; border: 1px solid #e4eae5; border-radius: 6px; background: #fafbf9; font-variant-numeric: tabular-nums; }
.sp-leave-day:hover { background: #edf3ee; border-color: #afc8b9; }
.sp-leave-day.is-selected { color: #fff; background: #245b4e; border-color: #245b4e; }
.sp-leave-day-mark { height: 13px; font-size: 9px; line-height: 13px; }
.sp-leave-summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; }
.sp-leave-summary p { margin: 0; font-size: 13px; }
.sp-leave-summary strong { color: #245b4e; font-weight: 650; }
.sp-leave-summary p > span { display: inline-block; margin-left: 10px; color: #6d7f73; font-size: 12px; }
.sp-leave-clear { min-height: 44px; padding: 0 4px; border: 0; background: transparent; color: #245b4e !important; font-size: 12px !important; }
.sp-leave-hint { margin: 0; font-size: 12px; line-height: 1.7; color: #6d7f73; }
.sp-leave-error { margin: 10px 0 0; padding: 8px 10px; border-radius: 6px; color: #a0362a; background: #fff2ee; font-size: 12px; }
.sp-leave-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; flex-shrink: 0; border-top: 1px solid #e5eae6; background: #fafbf9; }
.sp-leave-button { min-height: 44px; padding: 0 20px; border: 1px solid #d9e2da; border-radius: 7px; background: #fff; font-size: 13px !important; }
.sp-leave-button:hover { background: #f0f5f1; }
.sp-leave-button.is-primary { color: #fff; background: #245b4e; border-color: #245b4e; }
.sp-leave-button.is-primary:hover { background: #1c4b3f; }
.sp-leave-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 480px) {
  .sp-leave-backdrop { padding: 10px; }
  .sp-leave-dialog { max-height: calc(100dvh - 20px); }
  .sp-leave-heading { padding: 14px 10px 12px 12px; }
  .sp-leave-heading h2 { font-size: 17px; }
  .sp-leave-content { padding: 12px 10px 14px; }
  .sp-leave-actions { padding: 12px; }
  .sp-leave-actions > button { flex: 1; }
  .sp-leave-weekdays, .sp-leave-days { gap: 3px; }
}
@media (max-width: 350px) {
  .sp-leave-backdrop { padding: 4px; }
  .sp-leave-dialog { max-height: calc(100dvh - 8px); }
  .sp-leave-content { padding-right: 8px; padding-left: 8px; }
  .sp-leave-weekdays, .sp-leave-days { gap: 2px; }
  .sp-leave-heading h2 { font-size: 16px; }
}
</style>
