import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Build labels are calendar dates in Beijing, not semantic package versions. */
export function validateBuildVersion(value: unknown): string {
  if (typeof value !== 'string') throw new Error('构建号必须是 YYYY.MMDD.HHmm 格式的北京时间。')
  const match = /^(\d{4})\.(\d{2})(\d{2})\.(\d{2})(\d{2})$/.exec(value)
  if (!match) throw new Error('构建号必须是 YYYY.MMDD.HHmm 格式的北京时间。')
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59) {
    throw new Error(`构建号日期或时间无效：${value}`)
  }
  return value
}

export function formatBuildVersion(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new Error('无法从无效日期生成构建号。')
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return validateBuildVersion(`${parts.year.padStart(4, '0')}.${parts.month}${parts.day}.${parts.hour}${parts.minute}`)
}

export function resolveBuildVersion(environment: Record<string, string | undefined> = process.env, now = new Date()): string {
  // An explicit but malformed label is an error; never silently replace CI metadata.
  return environment.SHIFT_FLOW_BUILD_VERSION === undefined
    ? formatBuildVersion(now)
    : validateBuildVersion(environment.SHIFT_FLOW_BUILD_VERSION)
}

/** The run creation instant survives failed-job retries and a full run rerun. */
export function workflowBuildVersion(run: { id?: unknown; head_sha?: unknown; created_at?: unknown }, environment: Record<string, string | undefined>): string {
  if (!/^\d+$/.test(environment.GITHUB_RUN_ID || '') || String(run.id) !== environment.GITHUB_RUN_ID
    || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA || '') || run.head_sha !== environment.GITHUB_SHA) {
    throw new Error('构建记录与当前运行编号或源码提交不匹配。')
  }
  const timestamp = run.created_at
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    throw new Error('构建记录缺少有效的 UTC 创建时间。')
  }
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== timestamp) {
    throw new Error('构建记录的创建日期无效。')
  }
  return formatBuildVersion(date)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = process.argv.slice(2)
    const destination = options.find(option => option === '--github-output' || option === '--github-env')
    if (new Set(options).size !== options.length || options.some(option => !['--github-output', '--github-env', '--github-run'].includes(option))
      || (options.includes('--github-output') && options.includes('--github-env'))) {
      throw new Error('Usage: node scripts/build-version.ts [--github-output | --github-env] [--github-run]')
    }
    let version
    if (options.includes('--github-run')) {
      const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+$/.test(runId || '')) throw new Error('缺少有效的 GitHub 仓库或运行编号。')
      const run = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { encoding: 'utf8', timeout: 30_000 }))
      version = workflowBuildVersion(run, process.env)
    } else version = resolveBuildVersion()
    if (destination) {
      const output = destination === '--github-output'
      const file = process.env[output ? 'GITHUB_OUTPUT' : 'GITHUB_ENV']
      if (!file) throw new Error('缺少 GitHub Actions 构建环境文件。')
      appendFileSync(file, `${output ? 'build_version' : 'SHIFT_FLOW_BUILD_VERSION'}=${version}\n`)
    }
    console.log(version)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
