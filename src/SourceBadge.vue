<script lang="ts">
// Keep one provenance tooltip open without registering listeners for idle badges.
let closeActiveBadge: (() => void) | undefined
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { PlannerState } from './domain.ts'
import { formatChangeTime } from './changeTime'
import { latestConfigurationChange } from './dataProvenance'

const props = defineProps<{ state: PlannerState; path?: string; paths?: string[]; pending?: boolean }>()
const scopes = computed(() => props.paths ?? (props.path ? [props.path] : []))
const entry = computed(() => latestConfigurationChange(props.state.provenance, scopes.value))
const hasStatus = computed(() => !!props.pending || !!entry.value)
const labels = { manual: '手动修改', mcp: 'MCP', http: 'HTTP' } as const
const source = computed(() => props.pending ? 'pending' : entry.value?.source)
const label = computed(() => props.pending ? '未保存' : entry.value ? `${labels[entry.value.source]}${entry.value.source === 'manual' ? '' : ' 修改'}` : '')
const changedAt = computed(() => entry.value ? formatChangeTime(entry.value.at) : '时间未记录')
const description = computed(() => {
  const pending = props.pending ? '当前修改尚未保存。' : ''
  if (!entry.value) return `${pending}保存后记录修改来源与时间。`
  return `${pending}${props.pending ? '上次保存来源' : '最近修改来源'}：${labels[entry.value.source]}；${props.pending ? '上次修改时间' : '最近修改时间'}（本机时间）：${changedAt.value}`
})
const tooltipId = useId()
const trigger = ref<HTMLElement | null>(null)
const tooltip = ref<HTMLElement | null>(null)
const visible = ref(false)
const positioned = ref(false)
const position = ref({ left: '12px', top: '12px' })
let closeTimer = 0
let pinned = false
const overTrigger = ref(false)
const overTooltip = ref(false)

async function positionTooltip() {
  await nextTick()
  if (!visible.value || !trigger.value || !tooltip.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const box = tooltip.value.getBoundingClientRect()
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12))
  const above = anchor.top - box.height - 8
  const top = above >= 12 ? above : Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - box.height - 12))
  position.value = { left: `${left}px`, top: `${top}px` }
  positioned.value = true
}
function open() {
  window.clearTimeout(closeTimer)
  if (closeActiveBadge !== close) closeActiveBadge?.()
  closeActiveBadge = close
  if (!visible.value) positioned.value = false
  visible.value = true
  void positionTooltip()
}
function close() {
  window.clearTimeout(closeTimer)
  visible.value = false
  positioned.value = false
  pinned = false
  overTooltip.value = false
  if (closeActiveBadge === close) closeActiveBadge = undefined
}
function leave() {
  window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    if (!pinned && !overTrigger.value && !overTooltip.value && document.activeElement !== trigger.value) close()
  }, 150)
}
function toggle() {
  if (pinned) close()
  else { pinned = true; open() }
}
function outside(event: PointerEvent) {
  if (!trigger.value?.contains(event.target as Node) && !tooltip.value?.contains(event.target as Node)) close()
}
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  // Window capture precedes the enclosing dialogs' document-level Escape handlers.
  event.preventDefault()
  event.stopImmediatePropagation()
  close()
}
function scrolled(event: Event) {
  if (tooltip.value?.contains(event.target as Node)) return
  const anchor = trigger.value?.getBoundingClientRect()
  if (!anchor || anchor.bottom <= 0 || anchor.top >= window.innerHeight || anchor.right <= 0 || anchor.left >= window.innerWidth) close()
  else void positionTooltip()
}
watch(visible, opened => {
  if (opened) {
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', keydown, true)
    document.addEventListener('scroll', scrolled, true)
    window.addEventListener('resize', positionTooltip)
  } else {
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('keydown', keydown, true)
    document.removeEventListener('scroll', scrolled, true)
    window.removeEventListener('resize', positionTooltip)
  }
}, { flush: 'sync' })
watch(description, () => { if (visible.value) void positionTooltip() })
watch(hasStatus, shown => { if (!shown) close() })
onBeforeUnmount(close)
</script>

<template>
  <span v-if="hasStatus" ref="trigger" class="sp-source-badge" :class="`is-${source}`" :data-source="source" :data-source-path="scopes[0]" role="note" tabindex="0" :aria-label="description" :aria-describedby="visible ? tooltipId : undefined" @mouseenter="overTrigger = true; open()" @mouseleave="overTrigger = false; leave()" @focus="open" @blur="leave" @click.stop.prevent="toggle" @keydown.enter.stop.prevent="toggle" @keydown.space.stop.prevent="toggle" @keydown.tab="close"><svg v-if="source === 'mcp' || source === 'http'" class="sp-source-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="source === 'mcp' ? 'm12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4m-2-2h4' : 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18'" /></svg><span class="sp-source-badge-text">{{ label }}</span></span>
  <Teleport to="body">
    <div v-if="visible && hasStatus" :id="tooltipId" ref="tooltip" class="sp-source-tooltip" role="tooltip" :style="{ ...position, visibility: positioned ? 'visible' : 'hidden' }" @mouseenter="overTooltip = true; open()" @mouseleave="overTooltip = false; leave()">
      <strong v-if="pending">当前修改尚未保存</strong>
      <template v-if="entry">
        <p class="sp-source-tooltip-origin">{{ pending ? '上次保存来源' : '最近修改来源' }}：<strong>{{ labels[entry.source] }}</strong></p>
        <p class="sp-source-tooltip-date">{{ pending ? '上次修改时间' : '最近修改时间' }}（本机时间）<time v-if="changedAt !== '时间未记录'" :datetime="entry.at">{{ changedAt }}</time><span v-else>时间未记录</span></p>
      </template>
      <p v-else class="sp-source-tooltip-hint">保存后记录修改来源与时间。</p>
    </div>
  </Teleport>
</template>

<style scoped>
.sp-source-badge.sp-source-badge { display: inline-flex; align-items: center; flex: 0 0 auto; width: auto; min-width: 0; max-width: 100%; height: auto; padding: 2px 6px; margin: 0; border: 1px solid #dce5df; border-radius: 5px; background: #f2f6f3; color: #527360; font: 500 10px/1.35 "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; letter-spacing: 0; text-transform: none; white-space: nowrap; vertical-align: middle; cursor: help; touch-action: manipulation; }
.sp-source-badge.sp-source-badge:focus-visible { outline: 2px solid #276a56; outline-offset: 2px; }
.sp-source-badge.sp-source-badge.is-mcp, .sp-source-badge.sp-source-badge.is-http { box-sizing: border-box; flex-shrink: 1; gap: 4px; padding: 3px 7px; color: #fff; font-size: 11px; font-weight: 700; line-height: 1.3; white-space: normal; }
.sp-source-badge.sp-source-badge.is-mcp { border-color: #315ca8; background: #315ca8; }
.sp-source-badge.sp-source-badge.is-http { border-color: #75459b; background: #75459b; }
.sp-source-badge-icon { display: block; flex: 0 0 12px; width: 12px; height: 12px; }
.sp-source-badge-text { min-width: 0; overflow-wrap: anywhere; }
.sp-source-badge.sp-source-badge.is-pending { border-color: #ecdfc6; background: #fff8eb; color: #97743a; }
.sp-source-tooltip { position: fixed; z-index: 1400; box-sizing: border-box; width: min(270px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; overscroll-behavior: contain; padding: 12px 14px; border: 1px solid #dce5df; border-radius: 8px; background: #fff; color: #486052; box-shadow: 0 6px 24px #173d2826; font: 400 12px/1.7 "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; text-align: left; letter-spacing: normal; overflow-wrap: anywhere; }
.sp-source-tooltip p { margin: 0; }
.sp-source-tooltip > strong { display: block; margin-bottom: 7px; color: #97743a; font-size: 12px; font-weight: 600; }
.sp-source-tooltip-origin strong { color: #2f5946; font-weight: 600; }
.sp-source-tooltip .sp-source-tooltip-date { margin-top: 6px; color: #74887b; font-size: 11px; }
.sp-source-tooltip-date time, .sp-source-tooltip-date > span { display: block; margin-top: 2px; color: #304f3f; font: 500 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sp-source-tooltip .sp-source-tooltip-hint { margin-top: 3px; color: #74887b; font-size: 11px; }
</style>
