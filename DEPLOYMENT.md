# 部署 Shift Schedule Expert

这是独立 Vue 3 + TypeScript + Vite 项目，和 GameLink 游戏工程没有依赖关系。可部署静态网页，也可通过 Tauri 打包 Windows/macOS 桌面程序；两种产物的部署方式与排班引擎不同。

## 本地开发

使用 Node.js 22.18 或更高版本：

```sh
npm ci
npm run dev
```

默认开发端口为 5190。项目首页直接进入排班工作台，首次进入提供一份可编辑的示例团队。

## 构建和预览

```sh
npm test
npm run build
npm run preview
```

预览端口为 4190。将 `dist/` 内的全部内容上传至静态网站目录即可，也可以部署到域名下的子目录。无需服务端、数据库、GameLink SDK 或外部 AI 接口。网页自动排班使用浏览器 Worker 中的启发式算法；静态网页不能直接运行桌面内置的 Python CP-SAT 求解器。

请通过 HTTP / HTTPS 访问，不能直接双击 `index.html` 运行。HTTPS 有利于浏览器功能和数据保护。

## 桌面程序构建与分发

先按 [桌面构建指南](docs/DESKTOP_BUILD.md) 准备目标系统原生开发环境，再在 Windows 或 macOS 上执行：

```sh
npm ci
# 准备或检查项目 Python 环境，不冻结；已有正常环境会复用
npm run solver:ensure -- --dev
npm run solver:test
npm test
# 发行构建会按需生成完整 onedir 运行目录
npm run desktop:build
```

安装包位于 `src-tauri/target/release/bundle/`。发行构建把 `src-tauri/solver-runtime/` 整个 `onedir` 目录作为应用资源分发，包含 Python、OR-Tools CP-SAT 及其原生库；不能只复制目录中的可执行文件。最终用户不需要安装 Python。Windows 如果缺少 WebView2，安装程序可能需要联网安装这个系统 WebView 运行时。Windows 与 macOS、macOS Intel 与 Apple Silicon 需要各自原生构建，不能通过重命名文件转换平台。

开发运行使用 `npm run desktop:dev`，前置检查仅验证项目 `solver/.venv` 并执行小型自检，Tauri 直接调用这个固定环境中的 Python 与 `solver/main.py`。该路径不依赖发行运行目录，也不需要每次重新下载依赖或执行 PyInstaller。源码修改后重新发起求解会读取当前 Python 文件；若修改了 Rust、项目配置或启动脚本，应停止旧开发进程再重新启动。

专用 `.github/workflows/macos-arm64.yml` 手动触发，全部测试、原生资源审计及整月求解验证通过后，自动发布包含 DMG 和对应源码的 GitHub prerelease。已完成 macOS 15 ARM64 原生构建及包内求解测试，运行要求为 M 芯片、macOS 14+；Mac 图形界面与安装过程尚未实测。三平台 `.github/workflows/desktop-build.yml` 通过 **Build desktop installers** 手动触发，分别在 Windows x64、Intel Mac、M 芯片 Mac 原生运行器构建，全部检查通过后自动发布三个安装包、源码及报告；具体运行结果见对应 Actions 记录。完整范围见 [验证记录](docs/VERIFICATION.md)。默认构建未配置 Windows 商业代码签名或 Apple Developer ID 签名、公证。

桌面版通过本地进程通信求解，不需要部署 Python 服务。右上角 Setting 可按需开启内置 MCP / HTTP 服务，仅监听本机；连接方式见 [接口说明](docs/INTEGRATIONS.md)。桌面求解器缺失或启动失败时显示错误，不会退回网页算法。对安装包进行实际系统验证后，再向该平台的使用者分发。

已有项目升级时，同步更新 `package.json` / 锁文件、`scripts/`、`src-tauri/` 源码与配置、`src/` 和 `solver/` 源码，不删除应用本地数据或有效的同架构 `solver/.venv`。`npm run solver:doctor` 可生成不含员工数据的本地诊断文件 `solver/build/diagnostics-latest.json`；开发环境和发行运行目录将分别接受检查。

## 数据与日历

- 自动保存仅属于当前浏览器、当前网站域名，或当前桌面 WebView。网页、桌面程序、手机与电脑之间不会自动同步，可用 JSON 备份迁移。
- Excel 文件包含排班表、班次说明和津贴明细；重新编辑和恢复全部规则应使用 JSON 备份。
- 日历随 lunar-typescript 1.8.6 离线打包，当前完整自动核算 2025、2026 年；法定日期通过农历/节气及2025年起法定制度独立判断，不把整段连休当3倍日。历史制度、未知年度和无法确认的计薪日期提示待核对，可手动覆盖并随JSON备份转移。新增年度需升级依赖和重新构建，无运行时联网拉取。
- 加班津贴按工资基数、自然日类型及配置倍率估算；跨午夜分段计算。口径与官方资料见 `src/PAYROLL.md`。
- 网页在人手不足时保留缺口并给出提醒；桌面 CP-SAT 默认要求完整覆盖，明确开启“允许缺员”后才允许缺口。硬规则不能通过降低公平性评分来绕过，手工编辑也会进行规则检查。
- 桌面求解区分已证明无解与超时尚未找到方案；后者不代表没有可行排班，求解失败不会清空原表。

## 指定人员不能同日同班

进入「排班规则」→「同日同班互斥」→「添加互斥组」，至少选择两位员工，再选择全部班次或指定班次。保存后重新生成排班。每个组在同一天的同一种适用班次内最多出现一人；同一天分别上早班和晚班仍允许。
