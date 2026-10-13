# 桌面构建与求解验证记录

## 2026-10-13：月／周工时与团队上班权重（源码验证）

本轮在 Linux 工作环境验证源码 Python 求解和 Chromium 界面，未重新构建 Windows、macOS 安装包。下方旧原生构建记录不能代替本轮安装包验证。

- Node 回归 **124 项通过**；包含日历月参考、分钟取整、跨月工时、星期份额、备份迁移、原生结果独立复核和构建验证入口。
- Python OR-Tools CP-SAT **51 项通过**；真实加权解回交 TypeScript 验证，另用 20 组配置对照前后端周配额。独立检查进一步对照了 300 组配置、1,554 个周片段。
- 真实求解验证入口跑通三种数据：原 155 班位模型显式不设最低工时后可行；默认每人月最低 144 小时的示例按预期无解且不返回排班；月最低 120、周最低 14、周末合计 40% 的两人模型得到 32 班、各 128 小时，独立检查无问题。
- 真实 Chromium 浏览器检查 **31 项通过**（成员工时 15、星期权重 16），桌面 1440 与手机 390 宽无页面横向溢出，两个套件均无控制台或页面错误。实际核对团队完整周 35 班、周一／周六合计 40%：2025 年 10 月五段配额为 24／35／35／35／24，总计 153。人数不足时生成失败，已锁定安排和原表保留。日历配额范围、总量、规则草稿保存、JSON 恢复及窄屏布局均有浏览器回归脚本。
- 类型检查、Vite 生产构建及两个 Mac 工作流内嵌脚本的语法检查通过。安装包验证入口已共用上述三类模型，下一次原生构建会针对随包求解器重新运行。

规则说明见 [成员工时](HOURS.md) 与 [上班权重](WEEKDAY_WEIGHTS.md)。浏览器脚本位于 `tests/browser/hours-settings.cjs`、`tests/browser/weekday-weights.cjs`，需本地 Vite 服务及 Playwright Chromium；运行方式见文件顶部。

---

验证日期：2026-10-12。现已完成 macOS 15 ARM64 原生安装包构建、包内求解器与资源审计；此前完成 Linux x86_64 窗口测试。Mac 图形界面交互、安装/卸载及文件对话框未实测，Windows 尚未原生验证。

## 1.1.1：Mac 签名资源封印修复

已发布 1.1.0 的原生下载诊断 [38281252565](https://github.com/ecojust/shift-planner-desktop/actions/runs/38281252565) 确认 DMG 完整、App 无隔离直接启动正常，但严格签名检查发现主程序和 Python.framework 两处缺少资源封印。此证据不代表 Gatekeeper 放行或用户 M5 实测。

新流程为 Python.framework 和最终 App 完整签名，并将逐个原生代码的严格签名检查纳入发布门槛。源码版本更新为 1.1.1；新的原生构建与下载复验结果以对应 Actions 记录为准。JSON 签名报告只保存在 Actions Artifacts，公开附件仍为安装包、源码和校验文件。

## 2026-10-13 更新：三平台构建、开发启动与日历

- `desktop-build.yml` 新增并固定 Windows x64、Intel Mac x64、Mac ARM64 三个原生任务，默认全部成功后自动发布；取消 `publish_release` 可只验证构建。三平台原生构建 [38277333420](https://github.com/ecojust/shift-planner-desktop/actions/runs/38277333420) 已全部通过并发布：Windows 通过 NSIS 静默安装验证；三个最终资源目录均生成 155 个班位、零缺员、独立规则检查零问题。
- 开发启动链路的 Python 依赖加载检查统一为 120 秒，加入模块导入位置及 20 秒一次性线程栈。源码加载与 CP-SAT 自检在本工作环境约 0.48 秒完成；这不代表已确认用户 M5 上的具体阻塞原因。
- 日历接入 `lunar-typescript@1.8.6`，删除程序内的 2026 公历日期表，保留独立法定计薪规则与人工日历优先级。当前完整自动核算 2025/2026，未来未覆盖年度保持待核对。
- 本地完整前端测试 65 项通过（包含 2026 全年 365 天独立官方日期对照与跨年津贴），类型检查和 Vite 构建通过；新增 3 项启动诊断、8 项 Mach-O 架构审计测试通过。
- 发布脚本 10 个隔离模拟场景通过：正常发布、缺附件、错误标签、上传失败、错误长度/摘要、未完成上传及无远端摘要时的下载校验。模拟检查不能替代原生安装包运行验证。

公开 Release 仅提供安装包、对应源码和校验和；JSON 验证报告保留在 Actions Artifacts（14 天），发布前仍完整检查报告。

## Mac 原生构建与最终 App 验证

原始构建：[38271663345](https://github.com/ecojust/shift-planner-desktop/actions/runs/38271663345)，对应源码提交 `e1e6df1dac5134b6ea6bef69bcc58b7c52fcb095`。随后在同类 macOS 15 ARM64 运行器上完成 [38273409897](https://github.com/ecojust/shift-planner-desktop/actions/runs/38273409897) 审计，没有重建或修改原始应用字节。

- 前端测试 57 项、Python OR-Tools 测试 21 项、Rust 普通测试 16 项全部通过；另两项真实集成测试单独执行并通过。
- 源码 Python 与发行 onedir 两条真实集成路径均返回 OPTIMAL、29 条安排、零缺员，完成进程回收与临时目录清理。
- 真正生成 `.app` 和 ARM64 `.dmg`，并在最终 `.app/Contents/Resources/solver-runtime` 内执行引擎加载与 CP-SAT 自检；分别约 1.13 秒、0.58 秒，OR-Tools 版本 9.14.6206。
- 用最终 App 内的求解器执行默认 12 人、2026 年 10 月、每日 2/2/1 人的排班模型，搜索预算 5 秒：返回 OPTIMAL、155 个班位、零缺员；结果通过独立 TypeScript 规则检查，问题数为零。建模与求解约 3.95 秒，包含启动的总耗时约 5.22 秒。
- 资源审计检查 234 个 Mach-O 对象均含 ARM64，103 个符号链接全部留在包内且有效；原始 DMG、App ZIP 校验和保持一致。

审计发现 NumPy 扩展声明的最高最低系统版本为 macOS 14.0。该历史构建的 Info.plist 仍声明 11.0，不能据此承诺支持 macOS 11–13；现有包按 **macOS 14+** 交付。后续 Mac 构建配置已明确提高至 14.0，自动发布前也会校验应用声明和实际依赖最低版本。macOS 14 的运行兼容性尚未单独实测。

当前包已作为 [macOS Apple Silicon 测试发行版](https://github.com/ecojust/shift-planner-desktop/releases/tag/macos-arm64-1.1.0) 公开，未进行 Apple Developer ID 签名或 Apple 公证。新的 `macos-arm64.yml` 由用户手动启动，在全部检查成功后自动发布 prerelease；当前三平台 `desktop-build.yml` 已扩展为 Windows x64、Intel Mac 与 Apple Silicon 原生构建，全部成功后可自动发布；新增平台的实际结果以本轮 Actions 记录为准。

## 定位与调整

用户在 Apple Silicon 上实测：项目虚拟环境执行 `solver/main.py --info` 立即返回 OR-Tools 9.14.6206，而旧 PyInstaller onefile 程序的 `--info` 持续挂起。证据将问题定位到冻结程序启动路径，没有证据断言具体卡在解压、签名检查或原生库加载的哪一步。

- 开发模式改用项目固定 `.venv` Python + `solver/main.py`，不运行旧 onefile。
- 发行模式改用完整 onedir 运行目录。macOS 使用专用 `macOS.files` 配置保留框架符号链接，Windows 使用资源目录映射。
- 120 秒启动预算与实际求解时限独立；显示阶段、区分错误、支持取消及进程回收。完整合法结果不因进程退出清理超时而丢失。
- 离线 `solver:doctor` 对比源码与新运行目录，旧 onefile 只记录存在情况，不启动它。

## 此前 Linux 启动修复验证

- `npm test`：57 项通过，包含规则、津贴、Excel、结果保护及新增进程超时/资源完整性测试。
- `npm run solver:test`：21 项实际 OR-Tools 测试通过，含阶段协议及原生小模型自检。
- Rust 普通测试：16 项通过，另 2 项集成测试显式执行。
- Rust 源码 Python 与冻结 onedir 两项集成测试均通过：先检查引擎，再求解整月模型，检查锁定休息、请假、进程回收和任务目录清理，各返回 OPTIMAL、29 条安排。
- 实际执行 PyInstaller onedir 构建。运行目录启动约 0.59 秒，小模型自检约 0.54 秒；这些是本次 Linux 测量值，不代表 Mac 速度。
- 开发前置检查约 1.2 秒通过，已有虚拟环境未重新安装依赖或冻结。`solver:doctor` 的源码/发行启动与实际求解四项检查均通过。
- `npm run desktop:build -- --debug --no-bundle` 成功，包含运行目录校验、Vue 类型检查、生产网页构建与 Rust 编译。
- 实际打开新版 Tauri/WebKit 窗口：显示 OR-Tools 9.14.6206 已通过启动检测；点击生成，15 秒搜索返回可行方案，155 个班位全部覆盖。读取实际保存的数据，经独立 TypeScript 规则检查为零问题。未宣称该模型已证明最优。
- 再次生成后通过窗口取消：155 条原安排逐项保持不变，任务缓存无剩余 job 目录，界面仅显示一次取消结果。
- 用实际 Tauri 配置解析器验证 macOS 专用配置合并及 Windows 配置保持，检查 bundler 源码确认 Mac 自定义目录复制保留符号链接。未把配置审查记作 Mac 实机运行。

Linux 窗口测试使用虚拟显示器与工作区 GTK/WebKit 运行库，未把这些库混入源码交付。

## 历史验证与平台范围

此前版本已经验证实际桌面 Excel 保存、网页 Worker 排班、过期异步结果丢弃及移动端布局。本次未重做全部导出操作；当前 57 项测试继续覆盖其核心规则与文件格式。

Windows 原生构建和运行尚未验证。Mac 已完成上文列明的原生构建和包内求解验证，但不包含人工安装/卸载、图形界面交互和文件对话框测试，也未完成 Developer ID 签名或公证。参见 [桌面构建说明](DESKTOP_BUILD.md)。

求解核心使用 OR-Tools CP-SAT，不实现 PerfectTablePlan 的遗传算法；参考范围见 [参考记录](PERFECTTABLEPLAN_REFERENCE.md)。
