export type IntegrationPermissions = { members: boolean; shifts: boolean; rules: boolean; assignments: boolean }
export type IntegrationPermission = keyof IntegrationPermissions

export const DEFAULT_INTEGRATION_PERMISSIONS: Readonly<IntegrationPermissions> = Object.freeze({
  members: true,
  shifts: false,
  rules: false,
  assignments: false,
})
export const INTEGRATION_PERMISSIONS_STORAGE_KEY = 'shift-planner:integration-permissions:v1'
const permissionKeys = ['members', 'shifts', 'rules', 'assignments'] as const
type PermissionStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Permissions belong to this device's settings, never to the AI-editable document. */
export function loadIntegrationPermissions(storage?: PermissionStorage): IntegrationPermissions {
  try {
    const raw = (storage ?? localStorage).getItem(INTEGRATION_PERMISSIONS_STORAGE_KEY)
    if (raw !== null) {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const saved = value as Record<string, unknown>
        if (permissionKeys.every(key => typeof saved[key] === 'boolean')) {
          return { members: saved.members as boolean, shifts: saved.shifts as boolean, rules: saved.rules as boolean, assignments: saved.assignments as boolean }
        }
      }
    }
  } catch { /* Missing or unreadable local preferences use the default permissions. */ }
  return { ...DEFAULT_INTEGRATION_PERMISSIONS }
}

/** Return the new settings only after persistence succeeds, so failed saves cannot grant access. */
export function setIntegrationPermission(current: Readonly<IntegrationPermissions>, key: IntegrationPermission, value: boolean, storage?: PermissionStorage): IntegrationPermissions {
  if (!permissionKeys.includes(key) || typeof value !== 'boolean') throw new Error('无效的外部写入权限')
  const next = { ...current, [key]: value }
  ;(storage ?? localStorage).setItem(INTEGRATION_PERMISSIONS_STORAGE_KEY, JSON.stringify(next))
  return next
}
