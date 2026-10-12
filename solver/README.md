# 内置 CP-SAT 本地排班求解器

使用固定版本 `ortools==9.14.6206`，纯本地 stdin/stdout 单次 JSON 协议，无 HTTP 服务、数据库或网络请求。开发模式直接使用项目 `solver/.venv` 的 Python；发行版把 Python 和 OR-Tools 冻结为完整 `onedir` 资源目录，在 Tauri 安装包中随应用分发，最终用户不需要单独安装 Python。

跨平台开发与验证，在项目根目录执行：

```sh
npm run solver:ensure -- --dev
npm run solver:test
npm run desktop:dev
```

`solver:ensure -- --dev` 按需准备虚拟环境并验证引擎信息和小型求解，不执行 PyInstaller；已有同架构的正常环境会复用。`desktop:dev` 的 npm 前置钩子会自动执行这一检查。macOS/Linux 也可直接运行 `solver/.venv/bin/python solver/main.py --info` 或 `--self-test`；Windows 对应解释器为 `solver/.venv/Scripts/python.exe`。

`--info` 实际加载本地原生引擎后返回 OR-Tools 版本。`--self-test` 进一步执行一个小型、双工作线程 CP-SAT 模型并检查最优解；不读取用户的排班数据。

发行构建执行 `npm run solver:build`，使用 PyInstaller `--onedir` 收集完整运行时到 `src-tauri/solver-runtime/`。Tauri 通过资源映射包含整个目录，运行时从应用 `resource_dir()/solver-runtime/shiftflow-solver`（Windows 加 `.exe`）启动；不再采用 `externalBin` 的平台后缀单文件，也不需要启动时解压 onefile。目录中的关联库必须一并分发。开发模式始终调用项目固定虚拟环境和 `main.py`，不从界面接受解释器或脚本路径。

运行 `npm run solver:doctor` 可离线对比源码环境与发行运行目录的 `--info`、`--self-test`，报告写入 `solver/build/diagnostics-latest.json`。它只使用内置测试模型，不读写或上传员工数据；发行目录尚未生成时，应按诊断中的缺失提示区分，不把开发 Python 正常等同于发行包已经验证。

桌面宿主使用 `--hosted`，求解器仅在 stderr 上写独立的 ASCII 阶段行：`SHIFTFLOW_STAGE_V1:loading`、`reading`、`solving`、`finishing`。分别表示进入 Python 后加载依赖、读取请求、开始约束计算和结果已写出。stdout 保持单个 JSON 响应；普通 CLI 调用不输出这些阶段行。

桌面启动预算与计算预算独立：启动、加载和读取阶段最多 120 秒，进入 `solving` 后才开始计算看门狗（用户设置的搜索时限加 15 秒返回余量），结果阶段另留 5 秒退出余量。CP-SAT 自身仍遵守用户的原始时限。`--info` 不执行排班计算，只使用启动预算。启动失败、原生计算未响应和 CP-SAT 返回 `UNKNOWN` 是不同情况，不能统一解释为排班无解。

Tauri 为每个任务创建独立缓存子目录作为工作与临时目录；任务结束或取消后，先回收整个进程树，再尝试清理该任务目录。新版发行目录不再执行每次启动的 onefile 解压，目录管理仍用于隔离运行期间的临时文件。

## 请求与结果

stdin 读取到 EOF 后处理一份 JSON（上限 8 MiB），stdout 只写一行 JSON。标准错误可用于诊断。

```json
{
  "protocolVersion": 1,
  "requestId": "uuid-from-client",
  "state": "完整 PlannerState 对象（src/domain.ts）",
  "options": { "timeLimitSeconds": 15, "allowPartial": false, "seed": 1010 }
}
```

结果字段：`protocolVersion`、`requestId`、`engine: "ortools-cp-sat"`、`status`、`issues`、`stats`、`message`。**只有 OPTIMAL / FEASIBLE 包含 assignments**，错误、无解和未找到结果时不能覆盖前端原排班。

- `OPTIMAL`：对当前目标已证明最优。
- `FEASIBLE`：找到满足硬约束的方案，尚未证明最终目标最优。
- `INFEASIBLE`：固定排班有明确冲突，或 CP-SAT 已证明模型无解。
- `UNKNOWN`：达到时限，尚无可行结果；不等于无解。
- `MODEL_INVALID`：请求不合法或模型验证失败。
- `ERROR`：求解器异常。

`stats` 包含实际建模加求解耗时 `wallTimeSeconds`、`shortageCount`（缺少的班次人次）、`optimal`，以及适用时的 `objectiveValue` 和 `bestBound`。不同员工、班次、权重配置的目标值不能横向作质量百分比分数。

## 硬约束

1. 员工每天最多一个班次；锁定休息占据整格。
2. 班次资格和整日请假。前一天开始、跨入请假日的夜班同样禁止。
3. 每班精确需求人数；只有显式 `allowPartial: true` 才允许缺员，且从不允许超配。
4. 月内锁定安排和全部月外安排原样保留；固定冲突显式拒绝，不偷偷删除。
5. 按周一至周日自然周计实际分钟；周日跨夜工时拆分到两个自然周，跨月历史参与计算。
6. 班间最短休息（包含月外历史），用扩展后的可选时间区间 NoOverlap 约束。
7. 连续工作按班次开始日期计算，跨月连续工作也参与限制。
8. 指定互斥分组成员在同一天同一班次最多一人，可限制全部或指定班次。

工时按整数分钟计算，非整分钟的周工时上限向下取整，最短休息向上取整，避免意外放宽硬约束。

## 优化目标

采用约束求解，不使用遗传算法，也不把违反硬规则当作可交易的罚分。

允许缺员时，先用最多剩余时间的 70% 最小化缺员；**只有缺员最少已被证明，才锁定该值并继续优化公平性**。第一阶段到达时限则返回当前可行解，明确不宣称最优。第二阶段没有来得及找到解时，保留第一阶段已有的可行解。

公平性是以下整数指标的加权和：

- **工时公平**：员工本月工时 / 每周工时上限 × 1000 后取整，最大与最小负荷之差 × 10。
- **班次轮换**：各班次可排员工本月次数的最大值与最小值之差，各 × 200。
- **周末轮班**：启用时，可排员工周末次数最大与最小之差 × 300。

完全无法参加某项排班的人不纳入该项公平比较。公平性是偏好，不改变请假、人员互斥和工时等硬限制。当前不将加班津贴计入目标；工资/津贴仍由既有日历与工资模块独立计算。

## 规模与时间保护

最多 200 人、24 班次、每月 31 天、15 万候选变量；排班历史 2 万条，同班互斥约束系数预算 200 万。日期范围 1900–2200 年；最短休息 0–168 小时、连续工作上限 1–366 天，周工时不超过 168 小时。默认总建模求解预算 15 秒，可设 0.01–60 秒；采用 2 个求解工作线程。模型达到时限会返回 UNKNOWN 或已有 FEASIBLE，不能承诺大规模复杂模型在时限内必有结果。

测试既覆盖求解器边界案例，也把默认 12 人、3 班、2/2/1 需求模型的结果交给原 TypeScript `validateSchedule` 独立交叉检查。
