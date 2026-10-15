<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import type { Employee, PlannerState } from './domain.ts'
import { createAvatarThumbnail } from './avatar.ts'
import ConfirmDialog from './ConfirmDialog.vue'
import SourceBadge from './SourceBadge.vue'

const props = defineProps<{ employee: Employee; error?: string; state?: PlannerState }>()
const emit = defineEmits<{ save: [profile: { name: string; role: string; group: string; avatarChanged: boolean; avatar: string | null }]; close: [] }>()
const titleId = useId(), descriptionId = useId()
const nameId = useId(), roleId = useId(), groupId = useId()
const dialog = ref<HTMLElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
// A failed create attempt may update the parent's draft before validation.
// Keep the opening values as the unsaved new member's stable comparison base.
const initialProfile = { name: props.employee.name, role: props.employee.role, group: props.employee.group, avatar: props.employee.avatar ?? null }
const draft = reactive({ name: props.employee.name, role: props.employee.role, group: props.employee.group })
const savedEmployee = computed(() => props.employee.id
  ? props.state?.employees.find(employee => employee.id === props.employee.id) ?? props.employee
  : initialProfile)
const avatar = ref(props.employee.avatar ?? null)
const avatarChanged = ref(false)
const avatarLoading = ref(false)
const profilePending = computed(() =>
  (['name', 'role', 'group'] as const).some(field => draft[field] !== savedEmployee.value[field])
  || avatarLoading.value
  || (avatarChanged.value && avatar.value !== (savedEmployee.value.avatar ?? null)),
)
const avatarError = ref('')
const avatarBroken = ref(false)
const avatarInitials = computed(() => Array.from(draft.name.trim()).slice(-2).join(''))
const pendingAvatarRemoval = ref<{ request: number; avatar: string | null; loading: boolean } | null>(null)
let avatarRequest = 0
async function selectAvatar(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  const request = ++avatarRequest
  avatarLoading.value = true; avatarError.value = ''
  try {
    const result = await createAvatarThumbnail(file)
    if (!mounted || request !== avatarRequest) return
    avatar.value = result; avatarChanged.value = true; avatarBroken.value = false
  } catch (error) {
    if (mounted && request === avatarRequest) avatarError.value = error instanceof Error ? error.message : '头像处理失败，请重新选择图片。'
  } finally { if (mounted && request === avatarRequest) avatarLoading.value = false }
}
function requestAvatarRemoval() {
  pendingAvatarRemoval.value = { request: avatarRequest, avatar: avatar.value, loading: avatarLoading.value }
}
function removeAvatar() {
  const pending = pendingAvatarRemoval.value
  pendingAvatarRemoval.value = null
  if (!pending || pending.request !== avatarRequest || pending.avatar !== avatar.value || pending.loading !== avatarLoading.value) return
  avatarRequest++; avatar.value = null; avatarChanged.value = true; avatarLoading.value = false; avatarError.value = ''; avatarBroken.value = false
}
// Opening or cancelling confirmation must not cancel an upload in progress.
// A newly resolved image or changed member makes an older confirmation stale.
watch([avatar, avatarLoading, () => props.employee], () => { pendingAvatarRemoval.value = null }, { deep: true, flush: 'sync' })
function save() { if (!avatarLoading.value && !pendingAvatarRemoval.value) emit('save', { ...draft, avatarChanged: avatarChanged.value, avatar: avatar.value }) }
let opener: HTMLElement | null = null
let previousOverflow = ''
let mounted = false
function focusables() {
  return [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex]') ?? [])].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0)
}
function keydown(event: KeyboardEvent) {
  if (pendingAvatarRemoval.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  event.stopPropagation()
  const controls = focusables(), first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
}
function containFocus(event: FocusEvent) { if (!pendingAvatarRemoval.value && mounted && dialog.value && !dialog.value.contains(event.target as Node)) nameInput.value?.focus() }
onMounted(() => {
  mounted = true
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', containFocus)
  nameInput.value?.focus()
})
onBeforeUnmount(() => {
  mounted = false; avatarRequest++
  document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', containFocus)
  if (document.body.style.overflow === 'hidden') document.body.style.overflow = previousOverflow
  const target = opener
  void nextTick(() => { if (target?.isConnected) target.focus({ preventScroll: true }) })
})
</script>

<template>
  <Teleport to="body">
    <div class="sp-employee-backdrop" @click.self="!pendingAvatarRemoval && emit('close')">
      <form ref="dialog" class="sp-employee-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" :inert="!!pendingAvatarRemoval" :aria-hidden="pendingAvatarRemoval ? true : undefined" tabindex="-1" novalidate @submit.prevent="save">
        <header><div><div class="sp-employee-title"><h2 :id="titleId">{{ employee.id ? '编辑成员资料' : '添加员工' }}</h2><SourceBadge v-if="state" :state="state" :path="`employees.${employee.id}`" :pending="profilePending" /></div><p :id="descriptionId">{{ employee.id ? '修改姓名、岗位与分组，保存后生效。' : '填写基本资料，创建后可在卡片上调整工时和可上班次。' }}</p></div><button type="button" class="sp-employee-close" aria-label="关闭人员编辑" @click="emit('close')">×</button></header>
        <div class="sp-employee-content">
          <div class="sp-employee-avatar-editor">
            <span class="sp-employee-avatar-preview" :style="{ background: employee.color }"><img v-if="avatar && !avatarBroken" :src="avatar" alt="头像预览" @error="avatarBroken = true" /><span v-else class="sp-employee-avatar-initials" aria-hidden="true">{{ avatarInitials }}</span></span>
            <div class="sp-employee-avatar-controls"><div><label class="sp-employee-avatar-upload"><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传成员头像" @change="selectAvatar"/><span>{{ avatar ? '更换头像' : '上传头像' }}</span></label><button v-if="avatar || avatarLoading" type="button" class="sp-employee-avatar-remove" @click="requestAvatarRemoval">移除头像</button></div><p v-if="avatarLoading" role="status">正在处理头像…</p><p v-else>JPG / PNG / WebP，最多 10 MB</p></div>
          </div>
          <p v-if="avatarError" class="sp-employee-error sp-employee-avatar-error" role="alert">{{ avatarError }}</p>
          <div class="sp-employee-field"><div class="sp-employee-field-heading"><label :for="nameId">员工姓名</label></div><input :id="nameId" ref="nameInput" v-model="draft.name" maxlength="80" required autocomplete="off" placeholder="例如：陈晨" /></div>
          <div class="sp-employee-fields"><div class="sp-employee-field"><div class="sp-employee-field-heading"><label :for="roleId">岗位</label></div><input :id="roleId" v-model="draft.role" maxlength="80" placeholder="例如：值班主管" /></div><div class="sp-employee-field"><div class="sp-employee-field-heading"><label :for="groupId">所属分组</label></div><input :id="groupId" v-model="draft.group" maxlength="80" placeholder="例如：一组" /></div></div>
          <p class="sp-employee-help">{{ employee.id ? '工时、可上班次与请假日期保留最新设置。' : '默认每周 40–48 小时，可上全部班次。' }}</p>
          <p v-if="error" class="sp-employee-error" role="alert">{{ error }}</p>
        </div>
        <footer><button type="button" @click="emit('close')">取消</button><button type="submit" class="is-primary" :disabled="avatarLoading">保存人员</button></footer>
      </form>
    </div>
  </Teleport>
  <ConfirmDialog v-if="pendingAvatarRemoval" title="移除头像？" :description="`${pendingAvatarRemoval.loading ? '将取消正在处理的头像，并移除编辑中的头像。' : '将移除编辑中的头像，改为显示姓名。'}点击“保存人员”后才会更新成员资料。`" confirm-label="确认移除" cancel-label="保留头像" @confirm="removeAvatar" @cancel="pendingAvatarRemoval = null" />
</template>

<style scoped>
.sp-employee-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.sp-employee-field{display:flex;flex-direction:column;gap:7px;min-width:0}.sp-employee-field-heading{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.sp-employee-avatar-controls>div{align-items:center}
.sp-employee-backdrop{position:fixed;z-index:1200;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:#162d286b;color:#304b40}.sp-employee-dialog{width:480px;max-width:100%;max-height:calc(100dvh - 40px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #dce4df;border-radius:12px;background:white;box-shadow:0 16px 56px #162d2826;font-size:14px;line-height:1.5}.sp-employee-dialog button,.sp-employee-dialog input{font:inherit;box-sizing:border-box}.sp-employee-dialog button{cursor:pointer;touch-action:manipulation}.sp-employee-dialog button:focus-visible,.sp-employee-dialog input:focus-visible{outline:2px solid #276a56;outline-offset:2px}.sp-employee-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 16px 14px 20px;border-bottom:1px solid #e5eae6;flex-shrink:0}.sp-employee-dialog header>div{min-width:0}.sp-employee-dialog h2{margin:0;font-size:18px;font-weight:650;overflow-wrap:anywhere}.sp-employee-dialog header p{margin:5px 0 0;font-size:12px;color:#6d7f73;line-height:1.7}.sp-employee-close{width:40px;height:40px;border:0;border-radius:7px;flex-shrink:0;background:transparent;color:#6d7f73;font-size:25px!important}.sp-employee-close:hover{background:#eef4ef}.sp-employee-content{min-height:0;overflow:auto;padding:18px 20px;overscroll-behavior:contain}.sp-employee-content label{display:flex;flex-direction:column;gap:7px;min-width:0;font-size:12px;color:#557263;font-weight:600}.sp-employee-content input{min-width:0;width:100%;min-height:42px;padding:10px 11px;border:1px solid #dbe4dd;border-radius:7px;background:#fcfdfc;color:#304b40;font-size:14px;font-weight:400}.sp-employee-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px}.sp-employee-help{margin:16px 0 0;font-size:12px;line-height:1.8;color:#7a8e80}.sp-employee-error{padding:10px 12px;margin:12px 0 0;border-radius:7px;background:#fff1ed;color:#a04c3a;font-size:12px;line-height:1.7}.sp-employee-dialog footer{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #e5eae6;flex-shrink:0;background:#fafcf9}.sp-employee-dialog footer button{min-height:40px;padding:9px 18px;border:1px solid #d9e2da;border-radius:7px;background:white;color:#446b57;font-size:13px}.sp-employee-dialog footer button:hover{background:#f0f5f1}.sp-employee-dialog footer .is-primary{color:white;background:#245b4e;border-color:#245b4e}.sp-employee-dialog footer .is-primary:hover{background:#1c4b3f}@media(max-width:720px){.sp-employee-backdrop{padding:10px}.sp-employee-dialog{max-height:calc(100dvh - 20px)}.sp-employee-dialog header{padding:14px 12px}.sp-employee-content{padding:16px}.sp-employee-content input{font-size:16px;min-height:44px}.sp-employee-close,.sp-employee-dialog footer button{min-height:44px}.sp-employee-close{width:44px;height:44px}.sp-employee-dialog footer{padding:12px 16px}}@media(max-width:380px){.sp-employee-fields{grid-template-columns:1fr;gap:12px}}
.sp-employee-avatar-editor{display:flex;align-items:center;gap:15px;margin-bottom:18px}.sp-employee-avatar-preview{width:64px;height:64px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid #dbe5de;border-radius:50%;background:#f2f6f3;overflow:hidden;color:#9aac9f}.sp-employee-avatar-preview img{width:100%;height:100%;object-fit:cover}.sp-employee-avatar-initials{font-size:19px;font-weight:600;line-height:1;color:#496976;white-space:nowrap}.sp-employee-avatar-controls{min-width:0}.sp-employee-avatar-controls>div{display:flex;gap:9px;flex-wrap:wrap}.sp-employee-content .sp-employee-avatar-upload{position:relative;display:inline-flex;flex-direction:row;align-items:center;justify-content:center;min-height:40px;padding:8px 12px;border:1px solid #d9e3db;border-radius:7px;background:#fff;color:#3e7057;font-size:12px;cursor:pointer}.sp-employee-avatar-upload>input{position:absolute!important;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;padding:0;border:0}.sp-employee-avatar-upload:focus-within{outline:2px solid #276a56;outline-offset:2px}.sp-employee-avatar-remove{border:0;background:transparent;color:#8a7667;font-size:12px!important;min-height:40px;padding:6px 3px}.sp-employee-avatar-controls p{font-size:11px;line-height:1.6;color:#809488;margin:7px 0 0}.sp-employee-avatar-error{margin-bottom:14px}.sp-employee-dialog footer button:disabled{opacity:.5;cursor:wait}@media(max-width:720px){.sp-employee-content .sp-employee-avatar-upload,.sp-employee-avatar-remove{min-height:44px}.sp-employee-avatar-editor{gap:12px}.sp-employee-avatar-preview{width:58px;height:58px}}
</style>
