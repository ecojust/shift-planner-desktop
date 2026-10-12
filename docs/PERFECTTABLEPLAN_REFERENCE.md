# PerfectTablePlan 遗传算法参考

核对日期：2026-10-12。以下基于官方公开说明，未使用其程序源码或逆向分析。

## 已确认的机制

官方技术页明确写道：“PerfectTablePlan does this using a genetic algorithm.” 按来宾亲近偏好排座时，先用启发式规则建立一组候选布局，再随机变异、拼接，淘汰低分布局，反复搜索。可按时间限制或连续若干代没有改进停止；不保证数学上的全局最优。

- 技术说明：https://www.perfecttableplan.com/html/genetic_algorithm.html
- FAQ：https://www.perfecttableplan.com/html/faq.html

帮助文档公开了评分表。例如希望相邻的来宾相邻得 +20；不希望靠近的来宾相邻扣 40、同桌扣 20。因此 **“Not Near to”是有惩罚的软偏好，不能理解为绝不允许同桌**。总分还使用平滑处理，避免只让少数人非常满意、多数人稍不满意；未公开平滑公式。

- 评分与自动分配：https://www.perfecttableplan.com/help/latest/windows/html/automatic_assignment_by_proximity.htm
- 偏好含义：https://www.perfecttableplan.com/help/latest/windows/html/proximity.htm

官方支持锁定指定座位或不分配座位，避免自动排座和拖动改变；重复运行尝试改善已有布局，停止时保留迄今最好方案，也可撤销。文档原文：“Click on the Stop button at any time during calculation to keep the best (highest scoring) plan so far.”

- 锁定机制：https://www.perfecttableplan.com/help/latest/windows/html/lock_guests_to_seats.htm

本次查阅的官方资料公开了总体过程、偏好评分和操作方式，未提供遗传算法源码、精确交叉/变异算子或全部参数。可以参考公开思路，不能声称采用其相同实现。

## 对本排班项目的建议

继续以本地 OR-Tools CP-SAT 为求解核心。请假、最短休息、工时上限、人员同日同班互斥、锁定班次属于硬约束，不能靠扣分后被公平性收益抵消。参考其产品机制，增加人工锁班、显示公平性分项、限时搜索、保留最好可行方案和继续优化。公平轮班可优化工时差、夜班差、周末班差；该模型是本项目自行定义，不照搬席位分数。

如以后引入遗传算法，可将其用于候选排序或软目标优化，但每个输出必须通过硬约束校验。遗传算法没搜到方案不等于无解；CP-SAT 也需区分已证无解、找到可行方案、已证最优和超时未找到方案。Tauri 可打包本地求解进程，Windows/macOS 使用同一模型，无需远程服务器。
