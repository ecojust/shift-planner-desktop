<script setup lang="ts">
import { computed, ref } from 'vue'
import { isAvatarData } from './avatarData.ts'

const props = withDefaults(defineProps<{ avatar?: string | null; size?: 'normal' | 'small' }>(), { avatar: null, size: 'normal' })
const failedSource = ref<string | null>(null)
const source = computed(() => isAvatarData(props.avatar) ? props.avatar : null)
function imageFailed(event: Event) { failedSource.value = (event.target as HTMLImageElement).getAttribute('src') }
</script>

<template>
  <span class="sp-employee-avatar" :class="{ 'is-small': size === 'small' }" aria-hidden="true">
    <img v-if="source && failedSource !== source" :key="source" :src="source" alt="" @error="imageFailed"/>
    <svg v-else viewBox="0 0 32 32"><circle cx="16" cy="11" r="5"/><path d="M6 28v-3a10 10 0 0 1 20 0v3"/></svg>
  </span>
</template>

<style scoped>
.sp-employee-avatar{display:flex;align-items:center;justify-content:center;width:43px;height:43px;flex-shrink:0;border:1px solid #dce7df;border-radius:50%;background:#f0f5f1;overflow:hidden;color:#8ba294}.sp-employee-avatar>img{display:block;width:100%;height:100%;object-fit:cover}.sp-employee-avatar>svg{width:63%;height:63%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.sp-employee-avatar.is-small{width:31px;height:31px}@media(max-width:720px){.sp-employee-avatar.is-small{width:28px;height:28px}}
</style>
