# 排班时光：Windows / macOS 桌面构建

桌面版由 Vue 界面、Tauri 2 本地宿主、Python OR-Tools CP-SAT 求解器组成。求解器通过标准输入输出交换 JSON，不监听 HTTP 端口，不需要在线算法服务。Python 和原生求解库一起打进安装包，**使用者不需要安装 Python、Rust 或 Node.js**。

网页版本仍可独立构建。网页中的浏览器算法与桌面 CP-SAT 是不同求解引擎；桌面版本求解器不可用时应显示错误，不应把浏览器算法的结果冒充 CP-SAT 结果。

## 开发环境

- Node.js 24 LTS（项目最低版本见 `package.json`）。
- Python 3.12，脚本也允许 3.10–3.13；建议跟 CI 一致使用 3.12。
- Rust stable 和 Cargo，当前依赖要求 Rust 1.90 或更新版本。
- Windows：Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”、Windows SDK；使用 MSVC Rust 工具链。运行时需要 WebView2，Tauri Windows 安装程序负责检测和安装，系统缺少 WebView2 时首次安装可能需要联网。
- macOS：Xcode Command Line Tools，运行 `xcode-select --install` 安装。

开发环境安装依赖、首次编译时需要联网；正常排班求解在本机执行。

## 安装与运行

在项目根目录执行，路径中包含空格也可以使用：

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` 的 npm 前置钩子执行 `solver:ensure -- --dev`：检查本机 Python 架构和项目 `solver/.venv`，按需准备依赖，再用该环境运行 `solver/main.py --info` 和小型 `--self-test`。**开发运行直接调用项目虚拟环境，不冻结求解器，也不运行旧版 onefile 文件。** 已有正确架构、依赖完整的虚拟环境会复用，无需每次重新下载依赖。

`solver:setup` 在 `solver/.venv` 创建隔离环境，安装 `solver/requirements.txt` 固定的 OR-Tools 以及 PyInstaller 6.16.0。脚本不会修改系统 Python。若存在多个 Python，可以设置 `SHIFT_FLOW_PYTHON` 为所需解释器的完整路径后运行；该变量是一个路径，不是含参数的命令。

`desktop:build` 的前置检查面向发行目录：校验目标架构、源码和运行时摘要，以及实际引擎加载和小型求解结果，按需构建并复用有效产物。`desktop:prepare` 仍可手动执行 `solver:setup` 和 `solver:build`，但不是日常开发启动的必要步骤。

请优先使用上述 npm 命令。直接运行 `cargo` 或 `npx tauri dev` 不会执行 npm 的开发前置钩子，应先手动运行 `npm run solver:ensure -- --dev`。

Windows PowerShell 示例：

```powershell
$env:SHIFT_FLOW_PYTHON = 'C:\Program Files\Python312\python.exe'
npm run solver:setup
```

macOS 示例：

```sh
SHIFT_FLOW_PYTHON=/opt/homebrew/bin/python3.12 npm run solver:setup
```

开发模式每次请求启动新的 Python 进程，因此下一次求解会读取当前 `solver/*.py`。修改 Rust、Tauri 配置或启动脚本后，应停止旧开发进程再重新启动。发行版运行已冻结代码，修改求解源码后必须重新构建运行目录及安装包；也可用 `npm run solver:build` 单独重建运行目录。

## Apple Silicon 与已有项目更新

M 芯片 Mac 的原生组合为 Python `arm64` 和 Rust `aarch64-apple-darwin`。可用 `python3.12 -c "import platform; print(platform.machine())"`、`rustc -vV` 检查。若使用 Homebrew 且 Python 3.12 确实安装在其默认目录，可在首次准备时指定：

```sh
SHIFT_FLOW_PYTHON=/opt/homebrew/bin/python3.12 npm run solver:ensure -- --dev
```

已有项目更新不需要删除整个项目或反复下载整套 Python 依赖。先停止旧开发进程，再同步覆盖这些代码和配置：

- `package.json`、`package-lock.json` 与 `scripts/`，使新的开发前置钩子生效。
- `src-tauri/src/`、Rust 清单/锁文件及 Tauri 配置，切换开发解释器与发行资源路径。
- `src/` 与 `solver/` 的源码，保证界面、宿主阶段协议和求解器一致。

保留当前机器上正确架构的 `solver/.venv`。不要删除应用 WebView 数据目录或清除 `localStorage`，员工、规则及排班仍属于现有本地数据；更新前也可导出 JSON 备份。项目目录保持原位置，避免移动虚拟环境导致解释器路径失效。覆盖代码后执行：

```sh
npm ci
npm run desktop:dev
```

自动检查遇到错误架构的旧虚拟环境会停止并提示，不会删除它；只有这种情况才需要将 `solver/.venv` 改名备份，使用正确架构的 Python 重建。无需创建空文件或重命名其他系统的二进制。

历史版本曾出现 `binaries/shiftflow-solver-aarch64-apple-darwin doesn't exist`，属于当时 `externalBin` 单文件缺失。另一次 Mac 排查确认项目 Python 的 `--info` 可以立即完成，而旧 onefile 的 `--info` 长时间挂起；这是不同的问题。当前开发路径不再依赖这个旧文件，发行版也已改为完整目录分发，不应再用旧“先生成单文件”步骤作为现行启动说明。

## 生成安装包

```sh
npm ci
npm run solver:ensure -- --dev
npm test
npm run solver:test
npm run desktop:build
```

产物位于 `src-tauri/target/release/bundle/`：

| 构建系统 | 桌面产物 |
| --- | --- |
| Windows | NSIS `.exe` 和/或 `.msi`，以 Tauri 配置启用的目标为准 |
| macOS | `.app` 和 `.dmg` |

源码或静态网页 `dist/` **不是**桌面安装包。Windows 安装包必须在 Windows 上构建，macOS 安装包必须在 macOS 上构建；本项目不把 Linux 构建成功视为 Windows/macOS 安装验证。

## CPU 架构和发行运行目录

Python 冻结产物不能直接跨系统、跨 CPU 架构使用。构建脚本读取 `rustc -vV` 中的 host triple，同时核对 Python 的平台和架构；不一致时停止构建。不要只修改文件名冒充另一平台。

| 系统与架构 | Rust host triple |
| --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` |
| macOS Apple Silicon | `aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` |

macOS Intel 和 Apple Silicon 分别用对应架构的 Python、Rust 进行原生构建，得到两个安装包。本流程没有生成 universal 通用包。Windows ARM64 没有列为已验证发行目标。

当前使用 PyInstaller `--onedir`，完整输出复制到 `src-tauri/solver-runtime/`。Tauri 通过 `bundle.resources` 将该目录映射为应用资源中的同名目录，不再配置 `externalBin`。发行宿主从 `resource_dir()/solver-runtime/shiftflow-solver`（Windows 加 `.exe`）启动求解器；旁边的 Python、`_internal/` 等关联资源必须完整保留，不能只拿可执行文件分发。

macOS 自动合并 `src-tauri/tauri.macos.conf.json`，改用 `bundle.macOS.files` 将整个运行目录复制到 `Contents/Resources/solver-runtime`，保留 Python framework 内的文件及目录符号链接。更新源码时必须一起保留这个配置；Windows 仍使用上述 `bundle.resources` 映射。两种方式下的 `resource_dir()` 启动路径一致。

这种分发方式不需要每次启动解压完整 Python 运行时，最终使用者仍不需要系统 Python。开发宿主则只使用项目内固定的虚拟环境解释器和 `solver/main.py --hosted`，不接受界面传入可执行文件路径。

桌面宿主在应用缓存目录的 `solver-runtime/` 下为每个任务创建独立的 `job-…` 子目录，将工作目录和 `TMPDIR`、`TMP`、`TEMP` 都指向该目录，用于运行期间的临时文件；它与安装包中的只读运行目录不是同一个目录。正常结束、取消或超时后，先等待整个求解进程树退出，再尝试删除该任务目录，不扫描或删除其他任务及系统临时文件；清理失败不会丢弃有效的求解结果。

`solver:build` 使用 `--collect-all ortools` 收集求解扩展与关联原生库。PyInstaller 显示 `Build complete` 只代表冻结完成；脚本随后实际运行目录中的 `--info` 和小型 `--self-test`，分别检查加载和原生约束搜索，并在 `solver/build/<host-triple>/manifest.json` 记录引擎信息、源码及运行目录摘要。`desktop:prepare` 只负责准备发行资源，不会启动应用窗口；日常开发直接执行 `desktop:dev`。

构建后的启动校验现在显示当前阶段且有独立超时，不会在 PyInstaller 成功后无限等待。桌面窗口也显示实际引擎检查状态；检查完成前不启动另一份排班任务，检查失败可以重试。

## 启动校验超时

如果自动排班弹窗中的引擎说明显示 `本地求解器暂不可用：TIMEOUT`，超时发生在 `--info` 启动校验，尚未进行排班计算。更换排班规则无法诊断这个阶段的问题。

更新代码后先停止旧开发进程，确认同步更新宿主、启动脚本、前端和 Python 文件，再执行 `npm run desktop:dev`。开发路径直接检查和使用虚拟环境，无需为这一步先冻结求解器；已经安装的发行版则需要重新构建安装包才能包含修改。

启动预算为 120 秒，进入 `solving` 阶段后才单独计用户搜索时限加 15 秒返回余量，结果阶段另有 5 秒退出余量。CP-SAT 内部搜索仍受用户原始时限限制；错误会指出最后停留的阶段。界面在初次引擎检查时显示真实状态，失败可以重试，不同时启动新的排班任务，也不重复弹出同一错误。

若仍无法启动，请运行 `npm run solver:doctor`。它分别执行项目虚拟环境与已打包目录中的 `--info` 和 `--self-test`，将结果保存到 `solver/build/diagnostics-latest.json`。诊断不会联网、安装依赖或读取、修改、上传员工排班数据；只使用合成测试模型。发行目录未生成时会记录缺失情况，开发解释器正常不等于发行目录已验证。

日志中的 `Rewriting the executable's macOS SDK version ...` 和 `Re-signing the EXE` 属于 PyInstaller 正常信息，不能单凭这两行判断程序启动失败。

用户取消、求解超时或退出程序时，Tauri 回收整个求解进程树，防止计算进程继续占用资源。

## GitHub Actions

专用 `.github/workflows/macos-arm64.yml` 在 Actions 中手动执行 **Build macOS Apple Silicon installer**，使用固定 `macos-15` ARM64 运行器。所有前端、Python、Rust、最终 App 加载、资源审计及整月排班验证通过后，自动创建 GitHub prerelease。发行版要求 M 芯片和 macOS 14+，附件包含独立 DMG、精确构建提交的源码 ZIP、验证报告与校验和；完整 App ZIP 仅保留在 Actions artifact 中，使用者不需要重复下载。

自动发布标签包含项目版本与 run ID。同一次运行重跑时先核对已有发行版对应的源码提交，不覆盖已发布附件。历史 `.github/workflows/macos-delivery.yml` 保留为手动草稿恢复流程，不会自动公开发布。

完整的三平台构建入口是 `.github/workflows/desktop-build.yml`：进入 GitHub Actions → **Build desktop installers** → **Run workflow**。固定使用以下原生运行器，避免 `macos-latest` 改变架构：

| 平台 | 运行器 | Python 架构 | 输出安装包 |
| --- | --- | --- | --- |
| Windows x64 | `windows-2022` | x64 | `shift-flow-windows-x64.exe`（NSIS） |
| Intel Mac | `macos-15-intel` | x64 | `shift-flow-macos-x64.dmg` |
| M 芯片 Mac | `macos-15` | arm64 | `shift-flow-macos-arm64.dmg` |

三个平台各自校验 Node/Python/Rust 架构，执行前端、Python、Rust 及真实求解集成测试，再构建原生安装包。Windows 在临时目录静默安装 NSIS，检查安装后的 x64 可执行文件、完整求解资源和实际整月求解；Mac 检查最终 App 的对应架构、内部链接、最低系统版本与整月求解。Mac 两种架构均要求 macOS 14+；Windows 包面向 Windows 10/11 x64，CI 验证环境为 Server 2022，不表示已逐一人工测试桌面系统。

只有三个构建任务都成功，后续 Release 任务才运行：先聚合验证报告、核对提交与 run ID，再附上精确源码 ZIP、SHA256SUMS，上传完整后公开测试版。标签为 `desktop-v<版本>-<run ID>`。任一平台失败不会发布残缺版本；成功平台的产物仍保留在各自 Actions artifact，保留期为 14 天。两个 Mac 架构不会覆盖彼此的附件。此入口已包含 M 芯片构建，无需同时再运行专用 ARM64 工作流。

Mac 原生构建 [38271663345](https://github.com/ecojust/shift-planner-desktop/actions/runs/38271663345)（源码 `e1e6df1`）及最终 App 审计/完整月求解 [38273409897](https://github.com/ecojust/shift-planner-desktop/actions/runs/38273409897) 均成功，现有包已发布为 [测试发行版](https://github.com/ecojust/shift-planner-desktop/releases/tag/macos-arm64-1.1.0)。验证环境为 macOS 15 ARM64；依赖要求 macOS 14+，不代表已遍历测试所有兼容系统版本。Mac 图形界面交互、安装/卸载、文件对话框仍未实测，Windows 尚未原生验证。详细证据与此前 Linux 窗口测试见 [验证记录](VERIFICATION.md)。

本地构建同样需要匹配架构的 Python 与 Rust；不能在 M 芯片运行器上重命名文件冒充 Intel 版本。新三平台流程的实际运行结果应以对应 Actions 日志及 Release 附带报告为准。

工作流默认使用无商业证书的测试构建，不要求上传签名证书。它不等同于完成 Windows 代码签名、Apple Developer ID 签名或 Apple 公证；正式对外发行前可按 Tauri 文档配置这些发行凭据。Windows SmartScreen、macOS Gatekeeper 对未签名/未公证应用的提示属于预期行为，不能在交付说明中声称已经签名或公证。

PyInstaller 在 macOS 收集原生组件时进行 ad-hoc 签名。将来使用 Developer ID 对外发行，需要对运行目录内的原生组件使用同一身份签名，再签外层应用并公证；仅给外层 Tauri 应用配置签名身份不等于目录内的组件已经完成发行签名。

## 源码交付

源码应包含 `src/`、`src-tauri/` 的配置和 Rust 源码、`solver/` 的 Python 源码与测试、`scripts/`、此文档及工作流文件。排除以下自动生成目录或文件：

- `node_modules/`、`dist/`
- `solver/.venv/`、`solver/build/`、`**/__pycache__/`
- `src-tauri/target/`、`src-tauri/solver-runtime/` 内自动生成的运行时文件（保留源码中用于目录占位的说明或占位文件）

旧版本残留的 `src-tauri/binaries/shiftflow-solver-*` 同样不应混入源码 ZIP；它们已不是当前打包输入。不要把源码 ZIP 的排除规则理解为升级时要删除用户本机的有效虚拟环境：分发源码时不带构建机环境，覆盖更新现有项目时保留本机环境，是两回事。

接收源码的开发者可在目标系统准备本机虚拟环境进行开发，发行时重新生成完整运行目录。安装后的最终用户使用包内运行时，不需要额外下载求解依赖。
