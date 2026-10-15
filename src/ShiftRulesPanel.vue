<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import type { PlannerState } from './domain.ts'
import ConfirmDialog from './ConfirmDialog.vue'
import ShiftSelect from './ShiftSelect.vue'
import SourceBadge from './SourceBadge.vue'

const props = defineProps<{ state: PlannerState }>()
const emit = defineEmits<{ change: [message: string] }>()
type Kind = 'nonConsecutiveShifts' | 'weeklyShiftLimits'
type SavedRow = { id: string; shiftId: string; maxPerWeek?: number }
type Row = { id: string; shiftId: string; maxPerWeek: number | string; source: string; error: string }
type DeleteRequest = {
  state: PlannerState; month: string; kind: Kind; row: Row; target: SavedRow; snapshot: string
  shift: PlannerState['shifts'][number]; shiftSnapshot: string; shiftName: string; maxPerWeek?: number
}
const groups = [
  { key: 'nonConsecutiveShifts' as const, title: '班次不相连', short: '不相连', description: '适用于每位成员：不能在连续两天上指定班次。', example: '例如周一上夜班，周二不能再上夜班；周三仍可安排。已知跨月安排也会检查。' },
  { key: 'weeklyShiftLimits' as const, title: '周班次限制', short: '周次数', description: '适用于每位成员：指定班次每个自然周最多安排几次。', example: '按周一至周日计算，月初、月末不足一周也使用同一上限，已知跨月安排计入。跨夜班按开始日期计次；0 次表示不安排该班。' },
]
const rows = reactive<Record<Kind, Row[]>>({ nonConsecutiveShifts: [], weeklyShiftLimits: [] })
const container = ref<HTMLElement | null>(null)
const pendingDelete = shallowRef<DeleteRequest | null>(null)
const deleteTitle = computed(() => pendingDelete.value ? `删除「${pendingDelete.value.shiftName}」${pendingDelete.value.kind === 'nonConsecutiveShifts' ? '不相连' : '周次数'}规则？` : '')
const deleteDescription = computed(() => {
  const item = pendingDelete.value
  if (!item) return ''
  const restriction = item.kind === 'nonConsecutiveShifts' ? '不能连续两天安排' : `每人每周最多 ${item.maxPerWeek} 次`
  return `将移除「${item.shiftName}」${restriction}的限制，其他排班规则和现有排班保持不变。此操作无法撤销。`
})
const saved = (kind: Kind): SavedRow[] => props.state.rules[kind] ?? []
const source = (rule: SavedRow) => JSON.stringify([rule.shiftId, rule.maxPerWeek ?? 0])
function synchronize(kind: Kind, reset = false) {
  const previous = reset ? [] : rows[kind]
  const next = saved(kind).map(rule => {
    const existing = previous.find(row => row.id === rule.id)
    return existing?.source === source(rule) ? existing : { id: rule.id, shiftId: rule.shiftId, maxPerWeek: rule.maxPerWeek ?? 2, source: source(rule), error: '' }
  })
  rows[kind] = [...next, ...previous.filter(row => !row.source)]
  for (const row of rows[kind]) if (row.shiftId && !props.state.shifts.some(shift => shift.id === row.shiftId)) {
    row.shiftId = ''; row.error = '原班次已删除，请重新选择。'
  }
}
watch(() => [props.state.rules.nonConsecutiveShifts, props.state.rules.weeklyShiftLimits, props.state.shifts], () => {
  for (const group of groups) synchronize(group.key)
}, { immediate: true, deep: true })
watch([() => props.state, () => props.state.month], () => {
  pendingDelete.value = null
  for (const group of groups) synchronize(group.key, true)
}, { flush: 'sync' })
watch(() => {
  const item = pendingDelete.value
  const target = item && saved(item.kind).find(rule => rule.id === item.target.id)
  const shift = item && props.state.shifts.find(shift => shift.id === item.shift.id)
  const row = item && rows[item.kind].find(row => row.id === item.row.id)
  return [props.state, props.state.month, target, JSON.stringify(target), shift, JSON.stringify(shift), row, row?.shiftId, row?.maxPerWeek, row?.source]
}, () => {
  if (pendingDelete.value && !validDeleteRequest(pendingDelete.value)) pendingDelete.value = null
}, { flush: 'sync' })
const sortedShifts = computed(() => props.state.shifts.map((shift, index) => ({ shift, index })).sort((a, b) => a.shift.start.localeCompare(b.shift.start) || a.index - b.index).map(item => item.shift))
const available = computed(() => Object.fromEntries(groups.map(group => [group.key, sortedShifts.value.filter(shift => !rows[group.key].some(row => row.shiftId === shift.id))])) as Record<Kind, PlannerState['shifts']>)
function dirty(kind: Kind, row: Row) {
  if (!row.source) return true
  const rule = saved(kind).find(item => item.id === row.id)
  return !rule || row.shiftId !== rule.shiftId || (kind === 'weeklyShiftLimits' && (String(row.maxPerWeek).trim() === '' || Number(row.maxPerWeek) !== rule.maxPerWeek))
}
function taken(kind: Kind, shiftId: string, rowId: string) { return rows[kind].some(row => row.id !== rowId && row.shiftId === shiftId) }
async function focusRow(kind: Kind, id?: string) {
  await nextTick()
  const element = id ? document.getElementById(`shift-rule-${kind}-${id}`)?.querySelector<HTMLButtonElement>('[role="combobox"]') : container.value?.querySelector<HTMLButtonElement>(`[data-add-rule="${kind}"]`)
  element?.focus({ preventScroll: true })
  element?.scrollIntoView({ block: 'nearest' })
}
function add(kind: Kind) {
  if (rows[kind].length >= 24 || !available.value[kind].length) return
  // getRandomValues also works on HTTP LAN previews, unlike randomUUID.
  const id = `shift-rule-${Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')}`
  const row = { id, shiftId: available.value[kind][0]!.id, maxPerWeek: 2, source: '', error: '' }
  rows[kind].push(row)
  void focusRow(kind, row.id)
}
function save(kind: Kind, row: Row) {
  row.error = ''
  if (!props.state.shifts.some(shift => shift.id === row.shiftId)) { row.error = '请选择现有班次。'; return }
  if (taken(kind, row.shiftId, row.id) || saved(kind).some(rule => rule.id !== row.id && rule.shiftId === row.shiftId)) { row.error = '该班次已有同类规则，请编辑已有规则或选择其他班次。'; return }
  if (kind === 'weeklyShiftLimits' && (String(row.maxPerWeek).trim() === '' || !Number.isInteger(Number(row.maxPerWeek)) || Number(row.maxPerWeek) < 0 || Number(row.maxPerWeek) > 7)) { row.error = '每周最多次数需为 0–7 的整数。'; return }
  if (!row.source && saved(kind).length >= 24) { row.error = '每类最多保存 24 条规则。'; return }
  if (row.source && !saved(kind).some(rule => rule.id === row.id)) { row.error = '这条规则已不存在，请取消后重新添加。'; return }
  const shiftName = props.state.shifts.find(shift => shift.id === row.shiftId)!.name
  if (kind === 'nonConsecutiveShifts') {
    const rule = { id: row.id, shiftId: row.shiftId }
    const current = props.state.rules.nonConsecutiveShifts ?? []
    props.state.rules.nonConsecutiveShifts = current.some(item => item.id === row.id) ? current.map(item => item.id === row.id ? rule : item) : [...current, rule]
    row.source = source(rule)
    emit('change', `已保存「${shiftName}」不相连规则。每位成员不能连续两天上此班，已有排班会重新检查。`)
  } else {
    const rule = { id: row.id, shiftId: row.shiftId, maxPerWeek: Number(row.maxPerWeek) }
    const current = props.state.rules.weeklyShiftLimits ?? []
    props.state.rules.weeklyShiftLimits = current.some(item => item.id === row.id) ? current.map(item => item.id === row.id ? rule : item) : [...current, rule]
    row.source = source(rule)
    emit('change', `已保存「${shiftName}」每人每周最多 ${rule.maxPerWeek} 次，已有排班会重新检查。`)
  }
  void focusRow(kind, row.id)
}
function cancel(kind: Kind, row: Row) {
  if (!row.source) rows[kind] = rows[kind].filter(item => item.id !== row.id)
  else {
    const rule = saved(kind).find(item => item.id === row.id)
    if (rule) Object.assign(row, { shiftId: rule.shiftId, maxPerWeek: rule.maxPerWeek ?? 2, source: source(rule), error: '' })
  }
  void focusRow(kind, rows[kind].find(item => item.id === row.id)?.id ?? rows[kind].at(-1)?.id)
}
function validDeleteRequest(item: DeleteRequest) {
  const target = saved(item.kind).find(rule => rule.id === item.target.id)
  const shift = props.state.shifts.find(shift => shift.id === item.shift.id)
  const row = rows[item.kind].find(row => row.id === item.row.id)
  return props.state === item.state && props.state.month === item.month
    && target === item.target && JSON.stringify(target) === item.snapshot
    && shift === item.shift && JSON.stringify(shift) === item.shiftSnapshot
    && row === item.row && !dirty(item.kind, row)
}
function requestDelete(kind: Kind, row: Row) {
  const target = saved(kind).find(rule => rule.id === row.id)
  const shift = props.state.shifts.find(shift => shift.id === row.shiftId)
  if (!target || !shift || dirty(kind, row)) return
  pendingDelete.value = {
    state: props.state, month: props.state.month, kind, row, target, snapshot: JSON.stringify(target),
    shift, shiftSnapshot: JSON.stringify(shift), shiftName: shift.name, maxPerWeek: target.maxPerWeek,
  }
}
function confirmDelete() {
  const item = pendingDelete.value
  pendingDelete.value = null
  if (item && validDeleteRequest(item)) remove(item.kind, item.row)
}
function remove(kind: Kind, row: Row) {
  const index = rows[kind].findIndex(item => item.id === row.id)
  const remaining = saved(kind).filter(item => item.id !== row.id)
  if (kind === 'nonConsecutiveShifts') {
    if (remaining.length) props.state.rules.nonConsecutiveShifts = remaining
    else delete props.state.rules.nonConsecutiveShifts
  } else {
    if (remaining.length) props.state.rules.weeklyShiftLimits = remaining as NonNullable<PlannerState['rules']['weeklyShiftLimits']>
    else delete props.state.rules.weeklyShiftLimits
  }
  rows[kind] = rows[kind].filter(item => item.id !== row.id)
  emit('change', '规则已删除，现有排班保持不变。')
  void focusRow(kind, rows[kind][Math.min(index, rows[kind].length - 1)]?.id)
}
</script>

<template>
  <div ref="container" class="sp-shift-rule-cards">
    <ConfirmDialog v-if="pendingDelete" :title="deleteTitle" :description="deleteDescription" @confirm="confirmDelete" @cancel="pendingDelete = null" />
    <section v-for="group in groups" :key="group.key" class="sp-shift-rule-card" :aria-labelledby="`shift-rules-${group.key}`" :data-rule-kind="group.key">
      <header>
        <div><div class="sp-shift-rule-heading"><h3 :id="`shift-rules-${group.key}`">{{ group.title }} <span>{{ saved(group.key).length }} 条</span></h3><SourceBadge :state="state" :path="`rules.${group.key}`" :pending="rows[group.key].some(row => dirty(group.key, row))" /></div><p>{{ group.description }}</p></div>
        <button type="button" class="sp-shift-rule-button" :data-add-rule="group.key" :aria-label="`添加${group.title}规则`" :disabled="rows[group.key].length >= 24 || !available[group.key].length" @click="add(group.key)">＋ 添加规则</button>
      </header>
      <div v-if="rows[group.key].length" class="sp-shift-rule-list">
        <form v-for="(row, index) in rows[group.key]" :id="`shift-rule-${group.key}-${row.id}`" :key="row.id" class="sp-shift-rule-row" :class="{ 'is-new': !row.source, 'is-weekly': group.key === 'weeklyShiftLimits' }" novalidate @submit.prevent="save(group.key, row)">
          <div class="sp-shift-rule-field"><span>指定班次</span><ShiftSelect v-model="row.shiftId" :shifts="sortedShifts" :disabled-ids="state.shifts.filter(shift => taken(group.key, shift.id, row.id)).map(shift => shift.id)" :label="`第 ${index + 1} 条${group.short}规则班次`" @update:model-value="row.error = ''" /></div>
          <label v-if="group.key === 'weeklyShiftLimits'" class="sp-shift-rule-field sp-shift-rule-count"><span>每人每周最多</span><div><input v-model="row.maxPerWeek" type="number" inputmode="numeric" min="0" max="7" step="1" :aria-label="`第 ${index + 1} 条周次数规则每周最多次数`" :aria-invalid="!!row.error" :aria-describedby="row.error ? `shift-rule-error-${group.key}-${row.id}` : undefined" @input="row.error = ''"/><span>次</span></div></label>
          <p v-else class="sp-shift-rule-description">不连续两天安排</p>
          <div class="sp-shift-rule-actions"><template v-if="dirty(group.key, row)"><span class="sp-shift-rule-pending">{{ row.source ? '未保存修改' : '待保存' }}</span><button type="button" class="sp-shift-rule-button" :aria-label="`取消第 ${index + 1} 条${group.short}规则修改`" @click="cancel(group.key, row)">取消</button><button type="submit" class="sp-shift-rule-button is-primary" :aria-label="`保存第 ${index + 1} 条${group.short}规则`">保存</button></template><button v-else type="button" class="sp-shift-rule-remove" :aria-label="`删除第 ${index + 1} 条${group.short}规则`" @click="requestDelete(group.key, row)">删除</button></div>
          <p v-if="row.error" :id="`shift-rule-error-${group.key}-${row.id}`" class="sp-shift-rule-error" role="alert">{{ row.error }}</p>
        </form>
      </div>
      <p v-else class="sp-shift-rule-empty">暂无限制，可按班次添加多条规则。</p>
      <p v-if="!available[group.key].length && rows[group.key].length" class="sp-shift-rule-empty">所有班次均已添加，可直接修改或删除现有规则。</p>
      <details class="sp-shift-rule-help"><summary>适用范围与示例</summary><p>{{ group.example }}</p><p>每行单独保存；同一班次每类只需添加一条，两类规则可以同时使用。保存后不会删除现有排班，重新生成时须同时满足这些规则。</p></details>
    </section>
  </div>
</template>

<style scoped>
.sp-shift-rule-heading{display:flex;align-items:center;flex-wrap:wrap;gap:5px 9px}
.sp-shift-rule-cards{display:grid;gap:18px;margin:18px 0}.sp-shift-rule-card{min-width:0;background:#fff;border:1px solid #e1e9e5;border-radius:12px;padding:22px 24px;color:#39545a}.sp-shift-rule-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.sp-shift-rule-card h3{font-size:15px;line-height:1.5;margin:0;font-weight:600}.sp-shift-rule-card h3>span{font-size:11px;line-height:1.6;font-weight:400;color:#84998d;margin-left:8px;white-space:nowrap}.sp-shift-rule-card p{margin:0}.sp-shift-rule-card header p{font-size:12px;line-height:1.8;margin-top:7px;color:#7c9087}.sp-shift-rule-card button,.sp-shift-rule-card input{font:inherit}.sp-shift-rule-button{border:1px solid #dce7e1;background:#fff;color:#527b68;border-radius:7px;padding:9px 13px;font-size:12px!important;min-height:40px;white-space:nowrap;cursor:pointer;flex-shrink:0}.sp-shift-rule-button:hover{background:#f0f6f2}.sp-shift-rule-button:disabled{opacity:.5;cursor:default}.sp-shift-rule-button.is-primary{background:#285e4f;border-color:#285e4f;color:#fff}.sp-shift-rule-button.is-primary:hover{background:#1d4b3e}.sp-shift-rule-card button:focus-visible,.sp-shift-rule-card input:focus-visible,.sp-shift-rule-help summary:focus-visible{outline:3px solid #99ddd4;outline-offset:2px}.sp-shift-rule-list{margin-top:18px;display:grid;gap:12px}.sp-shift-rule-row{display:grid;grid-template-columns:minmax(130px,1fr) minmax(110px,.8fr) auto;align-items:end;gap:12px 18px;min-width:0;padding:15px 0;border-top:1px solid #edf1ee;scroll-margin:150px}.sp-shift-rule-row.is-new{background:#f7faf8;border-radius:8px;border:1px solid #e2ece5;padding:14px}.sp-shift-rule-field{display:flex;flex-direction:column;gap:7px;font-size:11px;color:#6a8274;font-weight:600;min-width:0}.sp-shift-rule-count{max-width:160px}.sp-shift-rule-count>div{display:flex;align-items:center;background:#fbfdfc;border:1px solid #dce5df;border-radius:7px;min-height:41px;padding-right:12px;overflow:hidden}.sp-shift-rule-count input{border:0;background:transparent;min-width:0;width:100%;padding:10px 11px;font-size:13px;color:#3f6351;font-weight:400;outline-offset:-3px!important;min-height:39px}.sp-shift-rule-count>div>span{font-size:11px;color:#8c9c93;font-weight:400}.sp-shift-rule-description{font-size:12px;color:#6e8c7c;line-height:1.6;align-self:end;padding-bottom:11px}.sp-shift-rule-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:41px}.sp-shift-rule-pending{font-size:10px;color:#99794d;white-space:nowrap;margin-right:4px}.sp-shift-rule-remove{border:0;background:transparent;color:#879c90;font-size:12px!important;min-height:40px;padding:8px;cursor:pointer}.sp-shift-rule-remove:hover{color:#ac5b46}.sp-shift-rule-empty{font-size:12px;color:#8d9f95;line-height:1.8;padding-top:15px}.sp-shift-rule-error{grid-column:1/-1;padding:10px 12px;background:#fff3ee;border:1px solid #f2d9cc;border-radius:7px;font-size:12px;color:#ab5745;line-height:1.7}.sp-shift-rule-help{margin-top:14px;padding-top:12px;border-top:1px solid #e8eee9;color:#84988d;font-size:11px;line-height:1.9}.sp-shift-rule-help summary{cursor:pointer;color:#5c806b;font-size:12px;min-height:28px;line-height:1.8;padding:3px 0;width:fit-content;max-width:100%}.sp-shift-rule-help p{margin-top:9px}.sp-shift-rule-card,.sp-shift-rule-card p{overflow-wrap:anywhere}
@media(max-width:900px){.sp-shift-rule-row{grid-template-columns:minmax(0,1fr) minmax(0,.8fr)}.sp-shift-rule-actions{grid-column:1/-1}.sp-shift-rule-count{max-width:none}}
@media(max-width:720px){.sp-shift-rule-card{padding:17px 15px;border-radius:10px}.sp-shift-rule-card>header{gap:12px;flex-wrap:wrap}.sp-shift-rule-card>header>div{flex:1;min-width:180px}.sp-shift-rule-card h3{font-size:14px}.sp-shift-rule-card header p{font-size:12px}.sp-shift-rule-card>header>.sp-shift-rule-button{margin-left:auto}.sp-shift-rule-row{gap:12px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.sp-shift-rule-row>.sp-shift-rule-field:first-child{grid-column:1/-1}.sp-shift-rule-description{grid-column:1/-1;padding-bottom:0}.sp-shift-rule-count input{font-size:16px;min-height:44px}.sp-shift-rule-count>div{min-height:44px}.sp-shift-rule-button,.sp-shift-rule-remove{min-height:44px}.sp-shift-rule-help summary{min-height:34px}.sp-shift-rule-pending{margin-right:auto}.sp-shift-rule-card h3>span{display:inline-block}}
.sp-shift-rule-cards{gap:14px;margin:14px 0}.sp-shift-rule-card{padding:18px}.sp-shift-rule-list{margin-top:14px;gap:9px}.sp-shift-rule-row{padding:12px 0;gap:10px 15px}.sp-shift-rule-row.is-new{padding:12px}.sp-shift-rule-help{margin-top:12px;padding-top:10px}@media(max-width:720px){.sp-shift-rule-cards{gap:12px;margin:12px 0}.sp-shift-rule-card{padding:15px}.sp-shift-rule-row{gap:10px}.sp-shift-rule-row.is-new{padding:11px}}
</style>
