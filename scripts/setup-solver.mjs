import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureFrozen, parseFrozenInfo, findBuildPython, main, pyinstallerVersion, pythonDetails, run, solverRoot, venvPython, venvRoot } from './solver-tools.mjs';

main(async () => {
  if (!existsSync(venvPython)) {
    const python = findBuildPython();
    console.log(`创建求解器虚拟环境（Python ${python.details.version.join('.')}）…`);
    run(python.command, [...python.args, '-m', 'venv', venvRoot]);
  }
  const details = pythonDetails(venvPython);
  if (details.version[0] !== 3 || details.version[1] < 10 || details.version[1] > 13) {
    throw new Error('现有 solver/.venv 的 Python 版本不支持，请删除该虚拟环境后使用 Python 3.12 重建。');
  }
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(solverRoot, 'requirements.txt'), `pyinstaller==${pyinstallerVersion}`]);
  console.log('依赖安装完成，正在校验 Python / OR-Tools 启动…');
  const result = await captureFrozen(venvPython, [join(solverRoot, 'main.py'), '--info', '--hosted'], { startupTimeoutMs: 30_000 });
  console.log(JSON.stringify(parseFrozenInfo(result)));
  console.log('求解环境准备完成。最终桌面安装包会包含该求解器，使用者无需安装 Python。');
});
