<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import Icon from './Icon.vue'

defineProps<{ label: string }>()
const id = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const visible = ref(false)
const position = ref({ left: '12px', top: '12px' })
let pinned = false
let closeTimer = 0

async function open() {
  window.clearTimeout(closeTimer)
  visible.value = true
  await nextTick()
  if (!visible.value || !trigger.value || !tip.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const box = tip.value.getBoundingClientRect()
  const left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12))
  const above = anchor.top - box.height - 8
  const top = above >= 12 ? above : Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - box.height - 12))
  position.value = { left: `${left}px`, top: `${top}px` }
}
function close() { window.clearTimeout(closeTimer); visible.value = false; pinned = false }
function leave() {
  window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    if (!pinned && document.activeElement !== trigger.value) close()
  }, 150)
}
function toggle() { if (pinned) close(); else { pinned = true; void open() } }
function outside(event: PointerEvent) {
  if (visible.value && !trigger.value?.contains(event.target as Node) && !tip.value?.contains(event.target as Node)) close()
}
function keydown(event: KeyboardEvent) {
  if (visible.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  }
}
function scrolled(event: Event) { if (visible.value && !tip.value?.contains(event.target as Node)) close() }
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', keydown)
  document.addEventListener('scroll', scrolled, true)
  window.addEventListener('resize', close)
})
onUnmounted(() => {
  window.clearTimeout(closeTimer)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', keydown)
  document.removeEventListener('scroll', scrolled, true)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <button ref="trigger" type="button" class="sp-info-tip-trigger" :aria-label="label" :aria-describedby="visible ? id : undefined" :aria-expanded="visible" @mouseenter="open" @mouseleave="leave" @focus="open" @blur="leave" @keydown.tab="close" @click="toggle"><Icon name="info" :size="15" /></button>
  <Teleport to="body">
    <div v-if="visible" :id="id" ref="tip" class="sp-info-tip" role="tooltip" :style="position" @mouseenter="open" @mouseleave="leave"><slot /></div>
  </Teleport>
</template>

<style scoped>
.sp-info-tip-trigger { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #6d8879; cursor: help; vertical-align: middle; touch-action: manipulation; }
.sp-info-tip-trigger:hover, .sp-info-tip-trigger[aria-expanded="true"] { background: #edf3ef; color: #245b4e; }
.sp-info-tip-trigger:focus-visible { outline: 2px solid #276a56; outline-offset: 2px; }
.sp-info-tip { position: fixed; z-index: 1300; box-sizing: border-box; width: min(330px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; overscroll-behavior: contain; padding: 14px 16px; border: 1px solid #dce5df; border-radius: 9px; background: #fff; color: #486052; box-shadow: 0 6px 24px #173d2826; font-size: 12px; line-height: 1.8; text-align: left; overflow-wrap: anywhere; }
.sp-info-tip :deep(strong) { font-size: 13px; color: #2f5946; font-weight: 600; }
.sp-info-tip :deep(p) { margin: 7px 0 0; }
@media (pointer: coarse) { .sp-info-tip-trigger { width: 44px; height: 44px; } }
</style>
