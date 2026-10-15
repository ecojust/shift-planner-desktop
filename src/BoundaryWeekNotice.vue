<script setup lang="ts">
import { computed } from 'vue'
import type { PlannerState } from './domain.ts'
import { boundaryWeekNotices } from './solverGuidance.ts'

const props = defineProps<{ state: PlannerState; referenceDate?: string }>()
const weeks = computed(() => boundaryWeekNotices(props.state, props.referenceDate))
</script>

<template>
  <section v-if="weeks.length" class="sp-boundary-notice" aria-label="跨月自然周说明">
    <div v-for="week in weeks" :key="week.weekStart" class="sp-boundary-notice-week" :data-boundary-week="week.edge" :data-week-start="week.weekStart" :data-week-end="week.weekEnd">
      <div class="sp-boundary-notice-heading"><strong>{{ week.label }}</strong><span class="sp-boundary-notice-range"><time :datetime="week.weekStart">{{ week.weekStart }}</time><span aria-hidden="true"> — </span><time :datetime="week.weekEnd">{{ week.weekEnd }}</time><span class="sp-boundary-notice-weekdays">（周一至周日）</span></span></div>
      <ul class="sp-boundary-notice-items">
        <li v-for="item in week.items" :key="item.kind" :data-boundary-kind="item.kind"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></li>
      </ul>
    </div>
    <p class="sp-boundary-notice-scope">只保存本月，相邻月已有记录不变。临时预排不标记为已排班，也不代表相邻整月一定可排。</p>
  </section>
</template>

<style scoped>
.sp-boundary-notice { display: grid; gap: 8px; min-width: 0; padding: 10px 12px; border: 1px solid #dce6df; border-radius: 8px; background: #f7faf8; color: #52665a; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.sp-boundary-notice-week { min-width: 0; }
.sp-boundary-notice-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.sp-boundary-notice-heading > strong { flex-shrink: 0; color: #305f49; font-weight: 650; }
.sp-boundary-notice-range { min-width: 0; font-size: 11px; font-variant-numeric: tabular-nums; }
.sp-boundary-notice-range time { white-space: nowrap; }
.sp-boundary-notice-weekdays { white-space: nowrap; color: #708176; }
.sp-boundary-notice-items { display: grid; gap: 2px; margin: 2px 0 0; padding: 0; list-style: none; }
.sp-boundary-notice-items li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; margin: 0; }
.sp-boundary-notice-items strong { color: #3f6f54; font-size: 11px; font-weight: 650; }
.sp-boundary-notice-items [data-boundary-kind="unknown"] strong,
.sp-boundary-notice-items [data-boundary-kind="invalid"] strong { color: #925a21; }
.sp-boundary-notice-items [data-boundary-kind="preview"] strong { color: #376788; }
.sp-boundary-notice-scope { margin: 0; padding-top: 6px; border-top: 1px solid #e3eae5; color: #708176; font-size: 11px; line-height: 1.6; }
@media (max-width: 400px) {
  .sp-boundary-notice { gap: 7px; padding: 9px 10px; }
  .sp-boundary-notice-heading { gap: 0 6px; }
}
</style>
