<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'

withDefaults(defineProps<{ title: string; description: string; confirmLabel?: string; cancelLabel?: string }>(), {
  confirmLabel: '确认删除',
  cancelLabel: '取消',
})
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const id = useId()
const dialog = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const previousScope = previousFocus?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="tabpanel"], .sp-settings, .sp-calendar-card') ?? null
const focusSelector = 'button, input, select, textarea, a[href], summary, [tabindex]'
let previousOverflow = ''
let mounted = false

function available(element: HTMLElement) {
  return element.isConnected && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0
}
function focusables(scope: HTMLElement | null) {
  return [...(scope?.querySelectorAll<HTMLElement>(focusSelector) ?? [])].filter(element => element.tabIndex >= 0 && available(element))
}
function focusCancel() { cancelButton.value?.focus({ preventScroll: true }) }
function keydown(event: KeyboardEvent) {
  if (!mounted) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
  } else if (event.key === 'Tab') {
    event.stopPropagation()
    const controls = focusables(dialog.value)
    const first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }
}
function containFocus(event: FocusEvent) {
  if (mounted && dialog.value && !dialog.value.contains(event.target as Node)) focusCancel()
}
function restoreFocus() {
  const active = document.activeElement
  // A parent may already have moved focus to the next row after deleting one.
  if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement && available(active)) return
  if (previousFocus && available(previousFocus)) { previousFocus.focus({ preventScroll: true }); return }
  const scope = previousScope?.isConnected ? previousScope : document.querySelector<HTMLElement>('[role="dialog"], [role="tabpanel"], .sp-calendar-card, .sp-settings')
  const fallback = focusables(scope)[0] ?? scope
  if (!fallback || !available(fallback)) return
  const temporaryTabIndex = !fallback.hasAttribute('tabindex') && fallback.tabIndex < 0
  if (temporaryTabIndex) fallback.setAttribute('tabindex', '-1')
  fallback.focus({ preventScroll: true })
  if (temporaryTabIndex) fallback.removeAttribute('tabindex')
}
onMounted(() => {
  mounted = true
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('focusin', containFocus)
  focusCancel()
})
onBeforeUnmount(() => {
  mounted = false
  document.removeEventListener('keydown', keydown, true)
  document.removeEventListener('focusin', containFocus)
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow
  void nextTick(restoreFocus)
})
</script>

<template>
  <Teleport to="body">
    <div class="sp-confirm-backdrop" @click.self="emit('cancel')">
      <section ref="dialog" class="sp-confirm-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" tabindex="-1">
        <header><h2 :id="`${id}-title`">{{ title }}</h2><button type="button" class="sp-confirm-close" aria-label="关闭确认弹窗" @click="emit('cancel')">×</button></header>
        <div class="sp-confirm-body"><p :id="`${id}-description`">{{ description }}</p><div v-if="$slots.default" class="sp-confirm-detail"><slot /></div></div>
        <footer><button ref="cancelButton" type="button" @click="emit('cancel')">{{ cancelLabel }}</button><button type="button" class="sp-confirm-danger" @click="emit('confirm')">{{ confirmLabel }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.sp-confirm-backdrop { position: fixed; z-index: 1400; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: #172d286b; color: #304b40; }
.sp-confirm-dialog { display: flex; flex-direction: column; width: 440px; min-width: 0; max-width: 100%; max-height: calc(100dvh - 40px); overflow: hidden; border: 1px solid #dce4df; border-radius: 12px; background: #fff; box-shadow: 0 18px 56px #162d2833; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.sp-confirm-dialog header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-shrink: 0; padding: 17px 16px 12px 20px; }
.sp-confirm-dialog h2 { min-width: 0; margin: 5px 0 0; font-size: 18px; line-height: 1.55; font-weight: 650; }
.sp-confirm-dialog button { font: inherit; cursor: pointer; touch-action: manipulation; }
.sp-confirm-dialog button:focus-visible { outline: 3px solid #99ddd4; outline-offset: 2px; }
.sp-confirm-close { flex-shrink: 0; width: 36px; height: 36px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: #718477; font-size: 25px !important; line-height: 1; }
.sp-confirm-close:hover { background: #eef4ef; }
.sp-confirm-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 20px 20px; color: #6d8376; }
.sp-confirm-body > p { margin: 0; white-space: pre-line; }
.sp-confirm-detail { margin-top: 12px; color: #82978b; font-size: 12px; }
.sp-confirm-detail :deep(p) { margin: 8px 0 0; }
.sp-confirm-dialog footer { display: flex; justify-content: flex-end; gap: 10px; flex-shrink: 0; padding: 14px 20px; border-top: 1px solid #e6ece7; background: #fafcf9; }
.sp-confirm-dialog footer button { min-height: 40px; max-width: 100%; padding: 8px 16px; border: 1px solid #d9e2da; border-radius: 7px; background: #fff; color: #446b57; }
.sp-confirm-dialog footer button:hover { background: #f0f5f1; }
.sp-confirm-dialog footer .sp-confirm-danger { background: #a8523d; border-color: #a8523d; color: #fff; }
.sp-confirm-dialog footer .sp-confirm-danger:hover { background: #934632; border-color: #934632; }
@media (max-width: 720px) {
  .sp-confirm-backdrop { padding: 12px; }
  .sp-confirm-dialog { max-height: calc(100dvh - 24px); }
  .sp-confirm-dialog header { padding: 14px 12px 10px 16px; gap: 10px; }
  .sp-confirm-body { padding: 0 16px 16px; }
  .sp-confirm-dialog footer { padding: 12px 16px; }
  .sp-confirm-dialog footer button { min-height: 44px; }
  .sp-confirm-close { width: 44px; height: 44px; }
}
</style>
