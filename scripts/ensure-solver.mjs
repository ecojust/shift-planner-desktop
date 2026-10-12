import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { capture, captureFrozen, parseFrozenInfo, findBuildPython, main, projectRoot, pyinstallerVersion, pythonDetails, run, solverRoot, venvPython } from './solver-tools.mjs';
import { runtimeInventory, solverSources } from './runtime-files.mjs';
import { hasCurrentMacSignatureFormat } from './seal-macos-runtime.mjs';

main(async () => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--dev')) throw new Error('用法：npm run solver:ensure [-- --dev]');
  const development = args[0] === '--dev';
  let rustInfo;
  try { rustInfo = capture('rustc', ['-vV']); }
  catch { throw new Error('未找到可用的 Rust 工具链。请安装 Rust stable，重新打开终端后再启动桌面版。'); }
  const host = rustInfo.match(/^host: (.+)$/m)?.[1]?.trim();
  const supported = /^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/.exec(host ?? '');
  if (!supported) throw new Error(`不支持的本机构建目标：${host ?? '未知'}。请使用目标系统的原生 Rust 工具链。`);
  const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || host;
  if (target !== host) throw new Error(`本地求解器需要原生构建：当前 Rust 为 ${host}，目标为 ${target}。请使用相同系统及架构的 Python 和 Rust。`);
  const runtime = join(projectRoot, 'src-tauri', 'solver-runtime');
  const binary = join(runtime, `shiftflow-solver${process.platform === 'win32' ? '.exe' : ''}`);
  const manifestPath = join(solverRoot, 'build', host, 'manifest.json');
  let validCache = false, reason = '目录版求解器尚未生成';
  if (!development && existsSync(binary) && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const sources = solverSources(projectRoot, solverRoot);
      const unchanged = manifest.sources && Object.keys(sources).length === Object.keys(manifest.sources).length
        && Object.entries(sources).every(([file, sha]) => manifest.sources[file] === sha);
      validCache = manifest.format === 'onedir' && manifest.target === host && manifest.pyinstaller === pyinstallerVersion
        && unchanged && manifest.selfTest?.selfTest === true && manifest.selfTest.status === 'OPTIMAL'
        && hasCurrentMacSignatureFormat(manifest)
        && manifest.runtime?.sha256 === runtimeInventory(runtime).sha256;
      reason = !hasCurrentMacSignatureFormat(manifest)
        ? 'macOS 求解器缺少完整 framework 签名或签名格式已更新'
        : '求解器源码、目录格式或资源完整性已变化';
    } catch (error) { reason = `现有运行目录校验未通过：${error.message}`; }
  }
  if (validCache) {
    console.log('正在校验目录版求解器启动（最多等待 120 秒）…');
    try {
      const info = parseFrozenInfo(await captureFrozen(binary, ['--info', '--hosted'], { cwd: runtime }));
      console.log(`目录版求解器已就绪：${relative(projectRoot, binary)}（OR-Tools ${info.version}）`);
      return;
    } catch (error) { throw new Error(`现有目录版求解器启动失败，已停止自动准备。请运行 npm run solver:doctor 获取阶段诊断。\n${error.message}`); }
  }
  const hadVenv = existsSync(venvPython);
  const python = hadVenv ? pythonDetails(venvPython) : findBuildPython().details;
  const arch = { AMD64: 'x86_64', amd64: 'x86_64', x86_64: 'x86_64', aarch64: 'aarch64', arm64: 'aarch64' }[python.machine];
  const platform = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[python.platform];
  if (arch !== supported[1] || platform !== supported[2]) throw new Error(`Python ${python.platform}/${python.machine} 与 Rust ${host} 架构不一致。M 芯片 Mac 请使用 arm64 Python 和 aarch64-apple-darwin Rust；已有错误架构的 solver/.venv 可先改名备份再重建。`);
  if (development) {
    if (!hadVenv) {
      console.log('首次准备开发环境，需要联网安装本地 Python 依赖…');
      run(process.execPath, [join(projectRoot, 'scripts', 'setup-solver.mjs')]);
    }
    console.log('正在校验开发模式 Python 求解器（启动最多 120 秒），不使用旧的单文件打包程序…');
    try {
      const commandArgs = [join(solverRoot, 'main.py')];
      const info = parseFrozenInfo(await captureFrozen(venvPython, [...commandArgs, '--info', '--hosted'], { cwd: projectRoot }));
      parseFrozenInfo(await captureFrozen(venvPython, [...commandArgs, '--self-test', '--hosted'], { cwd: projectRoot }), true);
      console.log(`开发求解器已就绪：项目 Python + OR-Tools ${info.version}，实际求解自检通过。`);
      return;
    } catch (error) { throw new Error(`开发模式求解器检查失败，已保留具体诊断；不会自动改用旧单文件程序。依赖缺失时运行 npm run solver:setup；启动异常时运行 npm run solver:doctor。\n${error.message}`); }
  }
  console.log(`${reason}，正在为 ${host} 准备目录版求解器。首次准备需要联网安装依赖并等待打包完成。`);
  run(process.execPath, [join(projectRoot, 'scripts', 'setup-solver.mjs')]);
  run(process.execPath, [join(projectRoot, 'scripts', 'build-solver.mjs')]);
  if (!existsSync(binary)) throw new Error(`求解器构建未产生预期文件：${binary}`);
});
