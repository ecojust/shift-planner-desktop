import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue'
import type { EmployeeDropPosition } from './employeeOrder'

export type EmployeeOrderChange = {
  visibleIds: string[]
  revision: number
  sourceId: string
  targetId: string
  position: EmployeeDropPosition
}
type Session = {
  sourceId: string
  name: string
  visibleIds: string[]
  revision: number
  handle: HTMLButtonElement
  pointerId?: number
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
}

/** Keep the document untouched until a complete, still-current move is saved. */
export function useEmployeeReorder(options: {
  table: () => HTMLTableElement | null
  canStart: () => boolean
  visibleIds: () => string[]
  revision: () => number
  commit: (change: EmployeeOrderChange) => boolean
}) {
  const session = shallowRef<Session | null>(null)
  const destination = ref(0)
  const announcement = ref('')
  let frame = 0
  const active = computed(() => session.value !== null)
  const sourceId = computed(() => session.value?.sourceId ?? '')
  const others = () => session.value?.visibleIds.filter(id => id !== session.value?.sourceId) ?? []
  const plan = computed(() => {
    const ids = others()
    if (!session.value || !ids.length) return null
    return destination.value < ids.length
      ? { targetId: ids[destination.value]!, position: 'before' as const }
      : { targetId: ids.at(-1)!, position: 'after' as const }
  })
  function rows() { return [...(options.table()?.querySelectorAll<HTMLTableRowElement>('tbody tr[data-employee-id]') ?? [])] }
  function current() {
    const value = session.value
    return !!value && options.canStart() && value.revision === options.revision()
      && value.visibleIds.join('\0') === options.visibleIds().join('\0')
  }
  function stop() {
    const value = session.value
    session.value = null
    window.cancelAnimationFrame(frame); frame = 0
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', drop, true)
    window.removeEventListener('pointercancel', pointerCancelled, true)
    window.removeEventListener('keydown', escape, true)
    window.removeEventListener('blur', interrupted)
    window.removeEventListener('resize', interrupted)
    document.removeEventListener('focusin', focusChanged, true)
    document.removeEventListener('scroll', scrolled, true)
    value?.handle.removeEventListener('lostpointercapture', interrupted)
    value?.handle.removeEventListener('blur', interrupted)
    if (value?.pointerId !== undefined && value.handle.hasPointerCapture(value.pointerId)) value.handle.releasePointerCapture(value.pointerId)
    return value
  }
  function refocus(value: Session) {
    void nextTick(() => {
      const handle = rows().find(row => row.dataset.employeeId === value.sourceId)?.querySelector<HTMLButtonElement>('.sp-employee-drag-handle')
      handle?.focus({ preventScroll: true })
    })
  }
  function cancel(restoreFocus = false) {
    const value = stop()
    if (!value) return
    announcement.value = '排序已取消，人员顺序未改变。'
    if (restoreFocus) refocus(value)
  }
  function interrupted() { cancel() }
  function focusChanged(event: FocusEvent) { if (event.target !== session.value?.handle) cancel() }
  function escape(event: KeyboardEvent) {
    if (session.value && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); cancel(true)
    }
  }
  function begin(source: string, name: string, handle: HTMLButtonElement, pointer?: PointerEvent) {
    if (!options.canStart()) return false
    const ids = options.visibleIds()
    if (ids.length < 2 || !ids.includes(source)) return false
    cancel()
    handle.focus({ preventScroll: true })
    session.value = {
      sourceId: source, name, handle, visibleIds: [...ids], revision: options.revision(),
      pointerId: pointer?.pointerId, startX: pointer?.clientX ?? 0, startY: pointer?.clientY ?? 0,
      x: pointer?.clientX ?? 0, y: pointer?.clientY ?? 0, moved: false,
    }
    destination.value = ids.indexOf(source)
    announcement.value = `${name}：排序已开始。使用上、下方向键选择位置，回车保存，Escape 取消。`
    window.addEventListener('pointermove', move, { capture: true, passive: false })
    window.addEventListener('pointerup', drop, true)
    window.addEventListener('pointercancel', pointerCancelled, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', interrupted)
    window.addEventListener('resize', interrupted)
    document.addEventListener('focusin', focusChanged, true)
    document.addEventListener('scroll', scrolled, true)
    handle.addEventListener('blur', interrupted)
    if (pointer) {
      handle.addEventListener('lostpointercapture', interrupted)
      try { handle.setPointerCapture(pointer.pointerId) } catch { /* Global listeners also cover synthetic and older pointer implementations. */ }
      frame = window.requestAnimationFrame(autoScroll)
    }
    return true
  }
  function pointerdown(source: string, name: string, event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || !(event.currentTarget instanceof HTMLButtonElement)) return
    event.preventDefault(); event.stopPropagation()
    begin(source, name, event.currentTarget, event)
  }
  function hitTest() {
    const value = session.value
    if (!value) return
    const remaining = rows().filter(row => row.dataset.employeeId !== value.sourceId)
    const index = remaining.findIndex(row => { const bounds = row.getBoundingClientRect(); return value.y < bounds.top + bounds.height / 2 })
    destination.value = index === -1 ? remaining.length : index
  }
  function move(event: PointerEvent) {
    const value = session.value
    if (!value || event.pointerId !== value.pointerId) return
    if (!current()) { cancel(); return }
    event.preventDefault()
    value.x = event.clientX; value.y = event.clientY
    if (Math.hypot(value.x - value.startX, value.y - value.startY) >= 6) value.moved = true
    if (value.moved) hitTest()
  }
  function insideTable(value: Session) {
    const table = options.table()
    const bounds = table?.tBodies[0]?.getBoundingClientRect()
    const viewport = table?.parentElement?.getBoundingClientRect()
    const top = Math.max(0, document.querySelector('.sp-topbar')?.getBoundingClientRect().bottom ?? 0)
    return !!bounds && !!viewport && value.x >= Math.max(0, viewport.left) && value.x <= Math.min(window.innerWidth, viewport.right)
      && value.y >= Math.max(top, bounds.top) && value.y <= Math.min(window.innerHeight, bounds.bottom)
  }
  function finish() {
    const value = session.value, change = plan.value
    if (!value || !change || !current()) { cancel(); return }
    // Drop is synchronous: clear the UI lease before the document watcher runs.
    stop()
    const saved = options.commit({ ...change, sourceId: value.sourceId, revision: value.revision, visibleIds: value.visibleIds })
    announcement.value = saved ? `${value.name}的顺序已保存，成员管理已同步。` : '人员顺序未改变。'
    refocus(value)
  }
  function drop(event: PointerEvent) {
    const value = session.value
    if (!value || event.pointerId !== value.pointerId) return
    event.preventDefault(); event.stopPropagation()
    value.x = event.clientX; value.y = event.clientY
    if (!value.moved || !insideTable(value)) { cancel(); return }
    hitTest(); finish()
  }
  function pointerCancelled(event: PointerEvent) { if (event.pointerId === session.value?.pointerId) cancel() }
  function keydown(source: string, name: string, event: KeyboardEvent) {
    const value = session.value
    if (!value) {
      if ((event.key === ' ' || event.key === 'Enter') && event.currentTarget instanceof HTMLButtonElement) {
        event.preventDefault(); event.stopPropagation(); begin(source, name, event.currentTarget)
      }
      return
    }
    if (source !== value.sourceId || value.pointerId !== undefined) return
    if (!current()) { cancel(); return }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    const last = value.visibleIds.length - 1
    destination.value = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, destination.value + (event.key === 'ArrowUp' ? -1 : 1)))
    announcement.value = `${value.name}：移至可见成员第 ${destination.value + 1} 位，共 ${value.visibleIds.length} 位。回车保存，Escape 取消。`
    rows().find(row => row.dataset.employeeId === plan.value?.targetId)?.scrollIntoView({ block: 'nearest' })
  }
  function scrolled() {
    if (session.value?.pointerId !== undefined && session.value.moved) {
      if (!current()) cancel()
      else hitTest()
    }
  }
  function autoScroll() {
    const value = session.value
    if (!value || value.pointerId === undefined) return
    if (!current()) { cancel(); return }
    const viewport = options.table()?.parentElement?.getBoundingClientRect()
    if (value.moved && viewport && value.x >= Math.max(0, viewport.left) && value.x <= Math.min(window.innerWidth, viewport.right)) {
      const top = Math.max(0, document.querySelector('.sp-topbar')?.getBoundingClientRect().bottom ?? 0)
      const edge = Math.min(56, (window.innerHeight - top) / 4)
      const speed = value.y < top + edge ? -Math.min(18, (top + edge - value.y) / 3)
        : value.y > window.innerHeight - edge ? Math.min(18, (value.y - window.innerHeight + edge) / 3) : 0
      if (speed) { window.scrollBy(0, speed); hitTest() }
    }
    frame = window.requestAnimationFrame(autoScroll)
  }
  function dropPosition(id: string) { return plan.value?.targetId === id ? plan.value.position : undefined }
  onBeforeUnmount(stop)
  return { active, sourceId, announcement, pointerdown, keydown, dropPosition, cancel }
}
