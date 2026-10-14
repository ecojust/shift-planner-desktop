<script setup lang="ts">
import { computed } from 'vue'
import type { Shift } from './domain.ts'
import AppSelect from './AppSelect.vue'

const props = defineProps<{ modelValue: string; shifts: Shift[]; disabledIds: string[]; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const options = computed(() => props.shifts.map(shift => ({
  value: shift.id,
  label: shift.name,
  description: `${shift.start} — ${shift.end < shift.start ? '次日 ' : ''}${shift.end}`,
  color: shift.color,
  shortLabel: shift.shortName,
  disabled: props.disabledIds.includes(shift.id),
})))
</script>

<template>
  <AppSelect :model-value="modelValue" :options="options" :label="label" placeholder="请选择班次" @update:model-value="emit('update:modelValue', $event)" />
</template>
