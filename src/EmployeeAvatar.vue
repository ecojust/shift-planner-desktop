<script setup lang="ts">
import { computed, ref } from 'vue'
import { isAvatarData } from './avatarData.ts'

const props = withDefaults(defineProps<{ name: string; color?: string; avatar?: string | null; size?: 'normal' | 'small' }>(), { color: '#d7e8f8', avatar: null, size: 'normal' })
const failedSource = ref<string | null>(null)
const source = computed(() => isAvatarData(props.avatar) ? props.avatar : null)
const initials = computed(() => Array.from(props.name.trim()).slice(-2).join(''))
function imageFailed(event: Event) { failedSource.value = (event.target as HTMLImageElement).getAttribute('src') }
</script>

<template>
  <span class="sp-employee-avatar" :class="{ 'is-small': size === 'small' }" :style="{ background: color }" aria-hidden="true">
    <img v-if="source && failedSource !== source" :key="source" :src="source" alt="" @error="imageFailed"/>
    <span v-else class="sp-avatar-initials">{{ initials }}</span>
  </span>
</template>

<style scoped>
.sp-employee-avatar{display:flex;align-items:center;justify-content:center;width:43px;height:43px;flex-shrink:0;border:1px solid #dce7df;border-radius:50%;background:#d7e8f8;overflow:hidden;color:#496976;font-size:13px;font-weight:600}.sp-employee-avatar>img{display:block;width:100%;height:100%;object-fit:cover}.sp-avatar-initials{line-height:1;white-space:nowrap}.sp-employee-avatar.is-small{width:31px;height:31px;font-size:10px}@media(max-width:720px){.sp-employee-avatar.is-small{width:28px;height:28px}}
</style>
