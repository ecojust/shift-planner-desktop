import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const marker = 'SHIFTFLOW_STAGE_V1:';
const validStages = new Set(['loading', 'reading', 'solving', 'finishing']);
const clean = text => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(-2048).trim();

/** Fixed caller-owned executable, no shell. A deadline owns the entire process tree. */
export function captureFrozen(command, args, options = {}) {
  const {
    startupTimeoutMs = 120_000, solveTimeoutMs = 15_000, finishTimeoutMs = 10_000,
    hardTimeoutMs = startupTimeoutMs + solveTimeoutMs + finishTimeoutMs,
    stdoutLimit = 1024 * 1024, stderrLimit = 256 * 1024,
    cwd, env = process.env, input, onStage,
  } = options;
  for (const value of [startupTimeoutMs, solveTimeoutMs, finishTimeoutMs, hardTimeoutMs, stdoutLimit, stderrLimit]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('进程时限与输出上限必须为正数。');
  }
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stage = 'starting', stageInput = '', stdoutBytes = 0, stderrBytes = 0;
    let stdout = [], stderr = [], failure = null, settled = false, killing = false;
    const stages = [];
    let phaseTimer, hardTimer, cleanupTimer;
    const seconds = () => Math.round((performance.now() - began) / 10) / 100;
    const diagnostics = () => ({ stage, elapsedSeconds: seconds(), stages: [...stages], stderr: clean(Buffer.concat(stderr).toString('utf8')) });
    const clear = () => {
      clearTimeout(phaseTimer); clearTimeout(hardTimer); clearTimeout(cleanupTimer);
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', terminated);
    };
    const complete = (code, signal) => {
      if (settled) return;
      settled = true; clear();
      const detail = diagnostics();
      if (failure || code !== 0) {
        const description = failure || `进程退出码 ${code ?? signal}`;
        const error = new Error(`${description}（阶段：${stage}，耗时 ${detail.elapsedSeconds} 秒）${detail.stderr ? `\n${detail.stderr}` : ''}`);
        error.code = failure?.startsWith('TIMEOUT:') ? 'TIMEOUT' : 'SOLVER_PROCESS_FAILED';
        error.diagnostics = detail;
        reject(error);
      } else resolve({ stdout: Buffer.concat(stdout).toString('utf8').trim(), ...detail, exitCode: code });
    };
    const killTree = () => {
      if (killing || !child.pid) return;
      killing = true;
      if (process.platform === 'win32') {
        // Fixed executable and numeric PID only; do not trust PATH for taskkill.
        const taskkill = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        const killTimer = setTimeout(() => { taskkill.kill(); child.kill(); }, 3000);
        taskkill.once('error', () => { clearTimeout(killTimer); child.kill(); });
        taskkill.once('close', () => { clearTimeout(killTimer); child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
      }
    };
    const stop = reason => {
      if (settled || failure) return;
      failure = reason;
      clearTimeout(phaseTimer); clearTimeout(hardTimer);
      killTree();
      // A broken inherited pipe must not keep a diagnostic or build command alive.
      cleanupTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        complete(null, 'SIGKILL');
      }, 5000);
    };
    function interrupted() { process.exitCode = 130; stop('CANCELLED: 操作已中断'); }
    function terminated() { process.exitCode = 143; stop('CANCELLED: 操作已终止'); }
    process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
    phaseTimer = setTimeout(() => stop('TIMEOUT: 求解器启动校验超时'), startupTimeoutMs);
    hardTimer = setTimeout(() => stop('TIMEOUT: 求解器已超过总运行时限'), hardTimeoutMs);
    child.once('error', error => { failure = `无法启动求解器：${error.message}`; complete(null, null); });
    child.once('close', complete);
    child.stdout.on('data', chunk => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) { stop('求解器标准输出超过上限'); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > stderrLimit) { stop('求解器诊断输出超过上限'); return; }
      stderr.push(chunk);
      stageInput += chunk.toString('utf8');
      let newline;
      while ((newline = stageInput.indexOf('\n')) !== -1) {
        const line = stageInput.slice(0, newline).trim();
        stageInput = stageInput.slice(newline + 1);
        if (!line.startsWith(marker)) continue;
        const next = line.slice(marker.length);
        if (!validStages.has(next) || next === stage) continue;
        // Ignore regressions/repeated markers: they cannot extend the deadline.
        const order = { starting: 0, loading: 1, reading: 2, solving: 3, finishing: 4 };
        if (order[next] <= order[stage]) continue;
        stage = next; stages.push({ stage, elapsedSeconds: seconds() });
        if (stage === 'solving' || stage === 'finishing') {
          clearTimeout(phaseTimer);
          phaseTimer = setTimeout(() => stop(`TIMEOUT: 求解器${stage === 'solving' ? '自检求解' : '退出'}超时`), stage === 'solving' ? solveTimeoutMs : finishTimeoutMs);
        }
        try { onStage?.({ stage, elapsedSeconds: seconds() }); }
        catch (error) { stop(`读取求解进度失败：${error.message}`); }
      }
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') stop(`写入求解器失败：${error.message}`);
    });
    child.stdin.end(input);
  });
}

export function parseFrozenInfo(result, selfTest = false) {
  let info;
  try { info = JSON.parse(result.stdout); }
  catch { throw new Error(`求解器没有返回有效 JSON（阶段：${result.stage}）。请运行 npm run solver:doctor。`); }
  if (info?.engine !== 'ortools-cp-sat' || info.protocolVersion !== 1 || info.local !== true
    || typeof info.version !== 'string' || (selfTest && (info.selfTest !== true || info.status !== 'OPTIMAL'))) {
    throw new Error(`求解器${selfTest ? '实际求解自检' : '版本校验'}失败。请运行 npm run solver:doctor。`);
  }
  return info;
}
