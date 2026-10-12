import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { capture, captureFrozen, parseFrozenInfo, main, projectRoot, pyinstallerVersion, pythonDetails, requireVenv, run, solverRoot, venvPython } from './solver-tools.mjs';
import { runtimeInventory, solverSources } from './runtime-files.mjs';
import { MAC_SIGNATURE_FORMAT, sealMacSolverRuntime } from './seal-macos-runtime.mjs';

main(async () => {
  requireVenv();
  const rustInfo = capture('rustc', ['-vV']);
  const host = rustInfo.match(/^host: (.+)$/m)?.[1]?.trim();
  if (!host) throw new Error('无法识别 Rust host triple，请安装 Rust stable 并确认 rustc 可执行。');
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--target')) throw new Error('用法：npm run solver:build [-- --target <当前机器的 Rust host triple>]');
  if ((args[1] ?? host) !== host) throw new Error(`不能跨平台冻结 Python 求解器：当前 ${host}，请求 ${args[1]}。请在目标系统和架构原生构建。`);
  const supported = /^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/.exec(host);
  if (!supported) throw new Error(`未配置的构建平台：${host}。Windows 使用 MSVC 工具链，macOS 使用对应的原生架构。`);
  const python = pythonDetails(venvPython);
  const arch = { AMD64: 'x86_64', amd64: 'x86_64', x86_64: 'x86_64', aarch64: 'aarch64', arm64: 'aarch64' }[python.machine];
  const platform = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[python.platform];
  if (arch !== supported[1] || platform !== supported[2]) throw new Error(`Python 架构 ${python.platform}/${python.machine} 与 Rust ${host} 不一致。请用同架构 Python 重建 solver/.venv。`);
  if (capture(venvPython, ['-m', 'PyInstaller', '--version']) !== pyinstallerVersion) throw new Error(`需要 PyInstaller ${pyinstallerVersion}。请运行 npm run solver:setup。`);
  const sources = solverSources(projectRoot, solverRoot);
  const work = join(solverRoot, 'build', host);
  mkdirSync(work, { recursive: true });
  console.log('正在构建目录版求解器（onedir），正式应用无需运行时解压 Python 和 OR-Tools。');
  run(venvPython, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--name', 'shiftflow-solver', '--collect-all', 'ortools',
    '--paths', solverRoot, '--distpath', join(work, 'dist'),
    '--workpath', join(work, 'work'), '--specpath', work, join(solverRoot, 'main.py'),
  ]);
  const extension = process.platform === 'win32' ? '.exe' : '';
  const source = join(work, 'dist', 'shiftflow-solver');
  const tauriRoot = join(projectRoot, 'src-tauri');
  const destination = join(tauriRoot, 'solver-runtime');
  const stagingRoot = mkdtempSync(join(tauriRoot, 'solver-runtime-stage-'));
  const staging = join(stagingRoot, 'payload'), backup = join(stagingRoot, 'previous');
  let movedPrevious = false;
  try {
    cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(staging, '.gitkeep'), '');
    const frozen = join(staging, `shiftflow-solver${extension}`);
    if (process.platform !== 'win32') chmodSync(frozen, 0o755);
    if (process.platform === 'darwin') console.log('正在完整封印 Python framework，并严格校验全部原生组件签名…');
    const macSignatures = sealMacSolverRuntime(staging);
    console.log('\n目录打包完成，正在校验启动（最多等待 120 秒）…');
    const startup = await captureFrozen(frozen, ['--info', '--hosted'], { cwd: staging });
    const solverInfo = parseFrozenInfo(startup);
    console.log(`启动校验通过（${startup.elapsedSeconds} 秒），正在执行实际 CP-SAT 小型求解自检…`);
    const check = await captureFrozen(frozen, ['--self-test', '--hosted'], { cwd: staging });
    const selfTest = parseFrozenInfo(check, true);
    console.log(`实际求解自检通过（${check.elapsedSeconds} 秒）。`);
    if (JSON.stringify(sources) !== JSON.stringify(solverSources(projectRoot, solverRoot))) throw new Error('构建期间求解器源码发生变化，请重新运行构建；旧运行目录未替换。');
    const runtime = runtimeInventory(staging);
    if (existsSync(destination)) { renameSync(destination, backup); movedPrevious = true; }
    try { renameSync(staging, destination); }
    catch (error) {
      if (movedPrevious) { renameSync(backup, destination); movedPrevious = false; }
      throw error;
    }
    const manifest = {
      generatedAt: new Date().toISOString(), format: 'onedir', target: host,
      python: python.version.join('.'), pyinstaller: pyinstallerVersion, solverInfo, selfTest,
      ...(macSignatures ? { macSignatureFormat: MAC_SIGNATURE_FORMAT, macSignatures } : {}),
      runtime: { ...runtime, directory: relative(projectRoot, destination).replaceAll('\\', '/') }, sources,
    };
    writeFileSync(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\n目录版求解器已就绪：${destination}\n${JSON.stringify(solverInfo)}\n资源：${runtime.fileCount} 个文件，SHA-256：${runtime.sha256}`);
  } finally {
    if (movedPrevious && !existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    rmSync(stagingRoot, { recursive: true, force: true });
  }
});
