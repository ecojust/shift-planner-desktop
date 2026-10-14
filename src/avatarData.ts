/** Keep 200 profile thumbnails small enough for ordinary offline workspaces. */
export const MAX_AVATAR_LENGTH = 8192

/** Only local, bounded JPEG data URLs are permitted in imported profiles. */
export function isAvatarData(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_AVATAR_LENGTH || !value.startsWith('data:image/jpeg;base64,')) return false
  const encoded = value.slice('data:image/jpeg;base64,'.length)
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false
  try {
    const bytes = atob(encoded)
    return bytes.length >= 5 && bytes.charCodeAt(0) === 255 && bytes.charCodeAt(1) === 216 && bytes.charCodeAt(2) === 255 && bytes.charCodeAt(bytes.length - 2) === 255 && bytes.charCodeAt(bytes.length - 1) === 217
  } catch { return false }
}
