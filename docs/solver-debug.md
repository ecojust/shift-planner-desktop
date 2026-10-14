# 导出排班规则与复现求解

在「排班日历」点击「导出规则」，可将当前月份的成员、可上班次、请假、班次人数模式、工时与排班规则导出为一个 JSON 文件。文件也包含锁定安排和跨月排班历史，以复现月首尾的工时、休息和连续工作约束。

排班失败后可用「导出本次规则」保存那次求解的输入；它保留原来的随机种子、时限和是否允许缺员，即使随后修改了界面设置也不受影响。日历工具栏的「导出规则」始终导出当前设置。

## 在源码求解器中直接运行

首次使用先按项目说明安装本地求解器依赖：

```sh
npm run solver:setup
```

macOS / Linux，在项目根目录运行（文件名有空格时保留引号）：

```sh
solver/.venv/bin/python solver/main.py --input "/路径/排班规则.json" > result.json
```

Windows PowerShell：

```powershell
solver\.venv\Scripts\python.exe solver/main.py --input "C:\路径\排班规则.json" > result.json
```

也可将 `--input` 和文件路径作为调试器的程序参数，入口为 `solver/main.py`。该方式从文件直接读取，不需要在终端输入 EOF。已打包的求解器也支持相同的 `--input` 参数。原有标准输入协议保持可用。

## JSON 内容

- 根字段 `protocolVersion`、`requestId`、`state`、`options` 是求解器可直接接受的完整请求，无需拆包或转换。
- `state.employees` 已将「跟随月参考工时」解析为本次的明确小时数；同时保留班次、规则、月份、月参考设置及排班历史。
- `options` 保存 `timeLimitSeconds`、`allowPartial`、`seed`。
- 额外的 `debug` 字段记录导出时间、构建版本、来源和运行环境；如提供了原始设置，还记录员工工时的继承值。求解器忽略这个辅助字段。

该文件包含员工姓名和请假等排班数据，向他人发送前可按需匿名化姓名。不要删除仍会影响约束的日期、班次资格或跨月安排。

`result.json` 中只有 `OPTIMAL` / `FEASIBLE` 会包含可用的 `assignments`。`INFEASIBLE` 表示已证明规则冲突；`UNKNOWN` 表示限时内尚未找到方案，不等于无解。同一输入便于复现约束与诊断；多线程搜索的耗时、优化结果和具体排班不保证逐次完全一致。

规则 JSON 用于求解器调试，不是应用的「导入备份」格式；日常迁移仍使用原有备份功能。
