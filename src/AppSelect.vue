<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import Icon from './Icon.vue'

defineOptions({ inheritAttrs: false })
type Option = { value: string; label: string; description?: string; color?: string; shortLabel?: string; disabled?: boolean }
const props = withDefaults(defineProps<{ modelValue: string; options: Option[]; label: string; placeholder?: string }>(), { placeholder: '请选择' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const id = useId()
const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)
const visible = ref(false)
const activeId = ref('')
const position = ref<Record<string, string>>({ left: '12px', top: '12px' })
const selected = computed(() => props.options.find(option => option.value === props.modelValue))
const enabled = computed(() => props.options.filter(option => !option.disabled))
const activeIndex = computed(() => props.options.findIndex(option => option.value === activeId.value))

function positionList() {
  if (!visible.value || !trigger.value) return
  const anchor = trigger.value.getBoundingClientRect()
  const detailed = props.options.some(option => option.description)
  const width = Math.min(Math.max(detailed ? 300 : 160, anchor.width), window.innerWidth - 24)
  const below = window.innerHeight - anchor.bottom - 20
  const above = anchor.top - 20
  const showBelow = below >= Math.min(320, props.options.length * (detailed ? 64 : 44) + 12) || below >= above
  position.value = {
    left: `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(44, Math.min(320, showBelow ? below : above))}px`,
    ...(showBelow ? { top: `${anchor.bottom + 8}px` } : { bottom: `${window.innerHeight - anchor.top + 8}px` }),
  }
}
async function revealActive() {
  await nextTick()
  if (!visible.value || !list.value) return
  const option = list.value.querySelector<HTMLElement>('[data-active="true"]')
  if (!option) return
  // Scroll only the options, so keyboard navigation never moves the page.
  const top = option.offsetTop
  const bottom = top + option.offsetHeight
  if (top < list.value.scrollTop) list.value.scrollTop = top
  else if (bottom > list.value.scrollTop + list.value.clientHeight) list.value.scrollTop = bottom - list.value.clientHeight
}
function open(edge?: 'first' | 'last') {
  if (!props.options.length) return
  activeId.value = edge === 'first' ? enabled.value[0]?.value ?? '' : edge === 'last' ? enabled.value.at(-1)?.value ?? '' : enabled.value.find(option => option.value === props.modelValue)?.value ?? enabled.value[0]?.value ?? ''
  visible.value = true
  positionList()
  void revealActive()
}
function close(restoreFocus = false) {
  visible.value = false
  if (restoreFocus) trigger.value?.focus({ preventScroll: true })
}
function choose(value: string) {
  if (!enabled.value.some(option => option.value === value)) return
  emit('update:modelValue', value)
  close(true)
}
function move(direction: number) {
  const current = enabled.value.findIndex(option => option.value === activeId.value)
  const next = Math.min(enabled.value.length - 1, Math.max(0, current + direction))
  activeId.value = enabled.value[next]?.value ?? ''
  void revealActive()
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && visible.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab') close()
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!visible.value) open()
    else move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    open(event.key === 'Home' ? 'first' : 'last')
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (visible.value) choose(activeId.value)
    else open()
  }
}
function outside(event: Event) {
  if (visible.value && !trigger.value?.contains(event.target as Node) && !list.value?.contains(event.target as Node)) close()
}
function scrolled(event: Event) {
  if (visible.value && !list.value?.contains(event.target as Node)) close()
}
watch(() => props.modelValue, () => close())
watch(() => props.options, () => {
  if (!visible.value) return
  if (!enabled.value.some(option => option.value === activeId.value)) activeId.value = enabled.value[0]?.value ?? ''
  positionList()
  void revealActive()
}, { deep: true })
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  document.addEventListener('scroll', scrolled, true)
  window.addEventListener('resize', positionList)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('focusin', outside)
  document.removeEventListener('scroll', scrolled, true)
  window.removeEventListener('resize', positionList)
})
</script>

<template>
  <button v-bind="$attrs" ref="trigger" type="button" class="sp-app-select" :class="{ 'has-description': selected?.description }" role="combobox" :aria-label="label" :aria-describedby="`${id}-value`" aria-haspopup="listbox" :aria-expanded="visible" :aria-controls="visible ? `${id}-list` : undefined" :aria-activedescendant="visible && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined" :data-value="modelValue" :disabled="!options.length" @click="visible ? close() : open()" @keydown="keydown">
    <span v-if="selected?.color" class="sp-app-select-mark" :class="{ 'is-dot': !selected.shortLabel }" :style="{ background: selected.color }" aria-hidden="true">{{ selected.shortLabel }}</span>
    <span :id="`${id}-value`" class="sp-app-select-copy"><template v-if="selected"><strong>{{ selected.label }}</strong><small v-if="selected.description">{{ selected.description }}</small></template><span v-else>{{ placeholder }}</span></span>
    <Icon class="sp-app-select-caret" name="arrow" :size="14" />
  </button>
  <Teleport to="body">
    <ul v-if="visible" :id="`${id}-list`" ref="list" class="sp-app-select-list" role="listbox" :aria-label="label" :style="position">
      <li v-for="(option, index) in options" :id="`${id}-option-${index}`" :key="option.value" role="option" tabindex="-1" :aria-selected="option.value === modelValue" :aria-disabled="!!option.disabled" :aria-label="[option.label, option.description].filter(Boolean).join('，')" :data-value="option.value" :data-active="option.value === activeId" @mousedown.prevent @mouseenter="!option.disabled && (activeId = option.value)" @click="choose(option.value)">
        <span v-if="option.color" class="sp-app-select-mark" :class="{ 'is-dot': !option.shortLabel }" :style="{ background: option.color }" aria-hidden="true">{{ option.shortLabel }}</span>
        <span class="sp-app-select-copy"><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
        <small v-if="option.disabled" class="sp-app-select-disabled">不可选</small>
        <Icon v-else-if="option.value === modelValue" class="sp-app-select-check" name="check" :size="17" />
      </li>
    </ul>
  </Teleport>
</template>

<style scoped>
.sp-app-select { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; min-height: 40px; padding: 9px 10px; border: 1px solid #dce5df; border-radius: 9px; background: #fbfdfc; color: #3f6351; text-align: left; cursor: pointer; }
.sp-app-select.has-description { min-height: 58px; }
.sp-app-select:hover, .sp-app-select[aria-expanded="true"] { border-color: #9abdab; background: #f2f8f4; }
.sp-app-select-mark { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 32px; min-height: 32px; padding: 4px 2px; border: 1px solid #285e4f1a; border-radius: 7px; color: #23493b; font-size: 10px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; text-align: center; }
.sp-app-select-mark.is-dot { width: 10px; height: 10px; min-height: 0; padding: 0; border-radius: 50%; }
.sp-app-select-copy { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; font-size: 12px; font-weight: 400; }
.sp-app-select-copy strong { font-size: 12px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.sp-app-select-copy small { color: #82978b; font-size: 11px; line-height: 1.5; font-weight: 400; font-variant-numeric: tabular-nums; }
.sp-app-select-caret { flex-shrink: 0; color: #7b9988; transform: rotate(90deg); transition: transform .15s; }
.sp-app-select[aria-expanded="true"] .sp-app-select-caret { transform: rotate(-90deg); }
.sp-app-select-list { position: fixed; z-index: 1100; overflow: auto; overscroll-behavior: contain; margin: 0; padding: 6px; border: 1px solid #dbe7df; border-radius: 11px; background: #fff; color: #3f6351; box-shadow: 0 8px 26px #234e3724; list-style: none; }
.sp-app-select-list li { display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 9px 10px; border-radius: 7px; cursor: pointer; }
.sp-app-select-list li + li { margin-top: 3px; }
.sp-app-select-list li[aria-selected="true"] { background: #edf6f0; }
.sp-app-select-list li[data-active="true"] { background: #e4f0e8; outline: 1px solid #bbd6c5; outline-offset: -1px; }
.sp-app-select-list li[aria-disabled="true"] { opacity: .48; cursor: not-allowed; }
.sp-app-select-disabled { flex-shrink: 0; color: #7c9184; font-size: 10px; }
.sp-app-select-check { flex-shrink: 0; color: #3a8060; }
@media (pointer: coarse) { .sp-app-select, .sp-app-select-list li { min-height: 44px; } }
</style>
