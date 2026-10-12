import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { captureFrozen, parseFrozenInfo, main, projectRoot, solverRoot, venvPython } from './solver-tools.mjs';

main(async () => {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json') || args.length > 1) throw new Error('用法：npm run solver:doctor [-- --json]');
  const jsonOnly = args.includes('--json');
  const log = message => { if (!jsonOnly) console.log(message); };
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, node: process.version,
    checks: {},
  };
  async function check(name, label, command, commandArgs, options, parse) {
    log(`${label}…`);
    let observed;
    try {
      const result = await captureFrozen(command, commandArgs, { cwd: projectRoot, ...options });
      observed = { elapsedSeconds: result.elapsedSeconds, stage: result.stage, stages: result.stages,
        imports: result.stderr.split('\n').filter(line => line.startsWith('SHIFTFLOW_IMPORT_V1:')) };
      const data = parse(result);
      report.checks[name] = { ok: true, ...observed, data };
      log(`  通过（${result.elapsedSeconds} 秒）`);
      return data;
    } catch (error) {
      report.checks[name] = { ok: false, error: error.message.slice(-3000), ...observed, ...(error.diagnostics || {}) };
      log(`  失败：${error.message}`);
      return null;
    }
  }
  log('本地求解器诊断：只检查版本、启动与自带小型模型；不会读取排班、联网或重新构建。');
  const rust = await check('rust', '检查 Rust 目标', 'rustc', ['-vV'], { startupTimeoutMs: 15_000, hardTimeoutMs: 15_000 }, result => {
    const host = result.stdout.match(/^host: (.+)$/m)?.[1]?.trim();
    if (!host) throw new Error('Rust 没有返回 host triple。');
    return { host, version: result.stdout.split('\n')[0] };
  });
  if (existsSync(venvPython)) {
    await check('python', '检查项目 Python 架构', venvPython, ['-c',
      'import json, platform, sys; print(json.dumps({"version": platform.python_version(), "machine": platform.machine(), "platform": sys.platform}))'],
    { startupTimeoutMs: 15_000, hardTimeoutMs: 15_000 }, result => JSON.parse(result.stdout));
    const sourceInfo = await check('sourceInfo', '检查 Python 源码启动（含 OR-Tools 导入，最多 120 秒）', venvPython,
      [join(solverRoot, 'main.py'), '--info', '--hosted'],
      {}, result => parseFrozenInfo(result));
    if (sourceInfo) await check('sourceSelfTest', '检查开发模式实际 CP-SAT 求解', venvPython,
      [join(solverRoot, 'main.py'), '--self-test', '--hosted'],
      {}, result => parseFrozenInfo(result, true));
  } else report.checks.python = { ok: false, error: '项目 solver/.venv 不存在。诊断不会安装 Python。' };
  const architecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const platform = { darwin: 'apple-darwin', win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu' }[process.platform];
  const host = rust?.host || (architecture && platform ? `${architecture}-${platform}` : null);
  let runtimeExists = false;
  if (host && /^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/.test(host)) {
    const runtime = join(projectRoot, 'src-tauri', 'solver-runtime');
    const binary = join(runtime, `shiftflow-solver${process.platform === 'win32' ? '.exe' : ''}`);
    report.binary = relative(projectRoot, binary).replaceAll('\\', '/');
    report.format = 'onedir';
    const legacy = join(projectRoot, 'src-tauri', 'binaries', `shiftflow-solver-${host}${process.platform === 'win32' ? '.exe' : ''}`);
    report.legacyOnefile = { present: existsSync(legacy), used: false, note: '旧单文件程序不再使用，也不会在诊断中启动。' };
    runtimeExists = existsSync(binary);
    if (runtimeExists) {
      const info = await check('frozenInfo', '检查目录版求解器启动（最多 120 秒）', binary,
        ['--info', '--hosted'], { cwd: runtime }, result => parseFrozenInfo(result));
      if (info) await check('frozenSelfTest', '检查目录版求解器实际 CP-SAT 求解', binary,
        ['--self-test', '--hosted'], { cwd: runtime }, result => parseFrozenInfo(result, true));
      else report.checks.frozenSelfTest = { skipped: true, reason: '启动检查失败，避免重复等待；先比较 sourceInfo 和 frozenInfo。' };
    } else report.checks.frozenInfo = { skipped: true, reason: '发行目录尚未构建。开发启动不需要它；生成正式包时运行 npm run solver:build。' };
  } else report.checks.frozenInfo = { ok: false, error: '无法确定本机求解器目标架构。' };
  report.developmentReady = report.checks.sourceInfo?.ok === true && report.checks.sourceSelfTest?.ok === true;
  report.releaseReady = report.checks.frozenInfo?.ok === true && report.checks.frozenSelfTest?.ok === true;
  report.ok = runtimeExists ? report.releaseReady : report.developmentReady;
  const directory = join(solverRoot, 'build');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'diagnostics-latest.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  if (jsonOnly) console.log(JSON.stringify(report, null, 2));
  else {
    log(`\n诊断已保存：${relative(projectRoot, file)}`);
    log(report.ok ? (report.releaseReady ? '目录版求解器启动与实际求解均通过。' : '开发模式 Python 求解器检查通过；发行目录尚未构建，不影响 desktop:dev。') : '检查未通过。请提供上述失败阶段与 diagnostics-latest.json；不需要提供员工排班。');
  }
  if (!report.ok) process.exitCode = 1;
});
