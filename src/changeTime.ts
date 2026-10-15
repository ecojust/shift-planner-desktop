const missingTime = '时间未记录'
const absoluteIso = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** Display a recorded absolute timestamp in the user's local timezone. */
export function formatChangeTime(iso: string): string {
  if (typeof iso !== 'string') return missingTime
  const match = absoluteIso.exec(iso)
  if (!match) return missingTime

  // Date can silently normalize impossible dates such as February 30.
  const wallTime = new Date(`${match[1]}Z`)
  if (!Number.isFinite(wallTime.getTime()) || wallTime.toISOString().slice(0, 19) !== match[1]) return missingTime

  const time = new Date(iso)
  const year = time.getFullYear()
  if (!Number.isFinite(time.getTime()) || year < 0 || year > 9999) return missingTime
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(year).padStart(4, '0')}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}
