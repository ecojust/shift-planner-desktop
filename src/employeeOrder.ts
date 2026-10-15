export type EmployeeDropPosition = 'before' | 'after'

/** Move within the current visible order, leaving filtered-out members in place.
 * A stale/ambiguous list or a move that changes nothing returns the input array.
 * Employee objects are reused; this only changes their presentation order. */
export function reorderVisibleEmployees<T extends { id: string }>(
  employees: T[],
  visibleIds: readonly string[],
  sourceId: string,
  targetId: string,
  position: EmployeeDropPosition,
): T[] {
  if (visibleIds.length < 2 || sourceId === targetId || (position !== 'before' && position !== 'after')) return employees
  const sourceIndex = visibleIds.indexOf(sourceId), targetIndex = visibleIds.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0 || new Set(visibleIds).size !== visibleIds.length) return employees

  const indexes = new Map<string, number>()
  for (const [index, employee] of employees.entries()) {
    if (indexes.has(employee.id)) return employees
    indexes.set(employee.id, index)
  }
  const slots: number[] = []
  for (const id of visibleIds) {
    const index = indexes.get(id)
    // The caller's visible snapshot must still occur in the same relative order.
    if (index === undefined || index <= (slots.at(-1) ?? -1)) return employees
    slots.push(index)
  }

  const visible = slots.map(index => employees[index]!)
  const [source] = visible.splice(sourceIndex, 1)
  const insertionIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0) + (position === 'after' ? 1 : 0)
  visible.splice(insertionIndex, 0, source!)
  if (visible.every((employee, index) => employee === employees[slots[index]!])) return employees

  const reordered = [...employees]
  slots.forEach((slot, index) => { reordered[slot] = visible[index]! })
  return reordered
}
