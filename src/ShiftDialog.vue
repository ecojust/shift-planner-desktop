<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = defineProps<{ title: string; error?: string }>()
const emit = defineEmits<{ save: []; close: [] }>()
const titleId = useId(), descriptionId = useId()
const dialog = ref<HTMLFormElement | null>(null)
const errorElement = ref<HTMLElement | null>(null)
let previousOverflow = ''
let mounted = false
function focusFirst() { dialog.value?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus({ preventScroll: true }) }
function focusables() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]') ?? [])].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  event.stopPropagation()
  const controls = focusables(), first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
}
function containFocus(event: FocusEvent) { if (mounted && dialog.value && !dialog.value.contains(event.target as Node)) focusFirst() }
onMounted(() => {
  mounted = true
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', containFocus)
  focusFirst()
})
onBeforeUnmount(() => {
  mounted = false
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('focusin', containFocus)
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow
})
watch(() => props.error, async error => {
  if (!error) return
  await nextTick()
  if (mounted) { errorElement.value?.scrollIntoView({ block: 'nearest' }); errorElement.value?.focus({ preventScroll: true }) }
})
</script>

<template>
  <Teleport to="body">
    <div class="sp-shift-backdrop" @click.self="emit('close')">
      <form ref="dialog" class="sp-shift-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" tabindex="-1" @submit.prevent="emit('save')">
        <header><div><h2 :id="titleId">{{ title }}</h2><p :id="descriptionId">设置时间、人数规则和固定津贴，保存后生效。</p></div><button type="button" class="sp-shift-close" aria-label="关闭班次编辑" @click="emit('close')">×</button></header>
        <div class="sp-shift-dialog-body"><slot /><p v-if="error" ref="errorElement" class="sp-shift-dialog-error" role="alert" tabindex="-1">{{ error }}</p></div>
        <footer><button type="button" @click="emit('close')">取消</button><button type="submit" class="is-primary">保存班次</button></footer>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.sp-shift-backdrop { position: fixed; z-index: 1200; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: #162d286b; color: #304b40; }
.sp-shift-dialog { display: flex; flex-direction: column; width: 580px; max-width: 100%; max-height: calc(100dvh - 40px); overflow: hidden; border: 1px solid #dce4df; border-radius: 12px; background: #fff; box-shadow: 0 16px 56px #162d2826; font-size: 14px; line-height: 1.5; }
.sp-shift-dialog button, .sp-shift-dialog :deep(input) { font: inherit; box-sizing: border-box; }
.sp-shift-dialog button { cursor: pointer; touch-action: manipulation; }
.sp-shift-dialog button:focus-visible, .sp-shift-dialog :deep(input:focus-visible) { outline: 2px solid #276a56; outline-offset: 2px; }
.sp-shift-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 16px 14px 20px; border-bottom: 1px solid #e5eae6; flex-shrink: 0; }
.sp-shift-dialog h2 { margin: 0; font-size: 18px; font-weight: 650; }
.sp-shift-dialog header p { margin: 5px 0 0; font-size: 12px; color: #6d7f73; line-height: 1.7; }
.sp-shift-close { width: 40px; height: 40px; border: 0; border-radius: 7px; flex-shrink: 0; background: transparent; color: #6d7f73; font-size: 25px !important; }
.sp-shift-close:hover { background: #eef4ef; }
.sp-shift-dialog-body { min-height: 0; overflow: auto; padding: 18px 20px; overscroll-behavior: contain; }
.sp-shift-dialog-error { padding: 10px 12px; margin: 14px 0 0; border-radius: 7px; background: #fff1ed; color: #a04c3a; font-size: 12px; line-height: 1.7; }
.sp-shift-dialog footer { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid #e5eae6; flex-shrink: 0; background: #fafcf9; }
.sp-shift-dialog footer button { min-height: 40px; padding: 9px 18px; border: 1px solid #d9e2da; border-radius: 7px; background: #fff; color: #446b57; font-size: 13px; }
.sp-shift-dialog footer button:hover { background: #f0f5f1; }
.sp-shift-dialog footer .is-primary { color: #fff; background: #245b4e; border-color: #245b4e; }
.sp-shift-dialog footer .is-primary:hover { background: #1c4b3f; }
@media (max-width: 720px) {
  .sp-shift-backdrop { padding: 10px; }
  .sp-shift-dialog { max-height: calc(100dvh - 20px); }
  .sp-shift-dialog header { padding: 14px 12px; }
  .sp-shift-dialog-body { padding: 16px; }
  .sp-shift-dialog :deep(input) { font-size: 16px; min-height: 44px; }
  .sp-shift-dialog :deep(input[type="radio"]) { min-height: 0; }
  .sp-shift-close, .sp-shift-dialog footer button { min-height: 44px; }
  .sp-shift-close { width: 44px; }
  .sp-shift-dialog footer { padding: 12px 16px; }
}
@media (max-width: 400px) { .sp-shift-dialog :deep(.sp-settings-form-grid) { grid-template-columns: 1fr; } }
</style>
