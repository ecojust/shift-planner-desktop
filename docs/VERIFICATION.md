# 启动修复验证记录

验证日期：2026-10-12。构建与窗口测试环境为 Linux x86_64；Windows/macOS 安装和实机运行尚未验证。

## 定位与调整

用户在 Apple Silicon 上实测：项目虚拟环境执行 `solver/main.py --info` 立即返回 OR-Tools 9.14.6206，而旧 PyInstaller onefile 程序的 `--info` 持续挂起。证据将问题定位到冻结程序启动路径，没有证据断言具体卡在解压、签名检查或原生库加载的哪一步。

- 开发模式改用项目固定 `.venv` Python + `solver/main.py`，不运行旧 onefile。
- 发行模式改用完整 onedir 运行目录。macOS 使用专用 `macOS.files` 配置保留框架符号链接，Windows 使用资源目录映射。
- 120 秒启动预算与实际求解时限独立；显示阶段、区分错误、支持取消及进程回收。完整合法结果不因进程退出清理超时而丢失。
- 离线 `solver:doctor` 对比源码与新运行目录，旧 onefile 只记录存在情况，不启动它。

## 本次已验证

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

Windows 与 macOS 的原生安装包、安装/卸载、文件对话框及正式签名/公证仍需目标系统验证。提供的手动 GitHub Actions 工作流包含两种启动方式的集成检查，但尚未远程运行。参见 [桌面构建说明](DESKTOP_BUILD.md)。

求解核心使用 OR-Tools CP-SAT，不实现 PerfectTablePlan 的遗传算法；参考范围见 [参考记录](PERFECTTABLEPLAN_REFERENCE.md)。
