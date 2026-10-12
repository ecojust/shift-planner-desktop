import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export { captureFrozen, parseFrozenInfo } from './frozen-process.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const solverRoot = join(projectRoot, 'solver');
export const venvRoot = join(solverRoot, '.venv');
export const venvPython = join(venvRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const pyinstallerVersion = '6.16.0';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw new Error(`无法启动 ${command}：${result.error.message}`);
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} 退出码 ${result.status ?? result.signal}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

export function capture(command, args) {
  return run(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).stdout.trim();
}

export function requireVenv() {
  if (!existsSync(venvPython)) throw new Error('未找到本地求解环境，请先运行 npm run solver:setup。');
}

export function pythonDetails(command, prefix = []) {
  return JSON.parse(capture(command, [...prefix, '-c',
    'import json, platform, sys; print(json.dumps({"version": list(sys.version_info[:3]), "machine": platform.machine(), "platform": sys.platform}))',
  ]));
}

export function findBuildPython() {
  const candidates = process.env.SHIFT_FLOW_PYTHON
    ? [[process.env.SHIFT_FLOW_PYTHON, []]]
    : process.platform === 'win32'
      ? [['py', ['-3.12']], ['python', []], ['python3', []]]
      : [['python3.12', []], ['python3', []], ['python', []]];
  for (const [command, args] of candidates) {
    try {
      const details = pythonDetails(command, args);
      const [major, minor] = details.version;
      if (major === 3 && minor >= 10 && minor <= 13) return { command, args, details };
    } catch { /* Try the next installed interpreter. */ }
  }
  throw new Error('请安装 Python 3.12（支持 3.10–3.13），或把 SHIFT_FLOW_PYTHON 设为 Python 可执行文件的完整路径。');
}

export async function main(task) {
  try { await task(); } catch (error) {
    console.error(`\n排班 plus：${error.message}`);
    process.exitCode = 1;
  }
}
