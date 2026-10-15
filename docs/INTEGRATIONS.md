# MCP 与 HTTP API

桌面版内置 MCP 与 HTTP API 服务。外部 AI 可读取当前应用的数据，修改人员、班次、规则和排班，并检查规则冲突。

## 开启与连接

1. 打开桌面应用右上角 **Setting**，开启 **MCP**。
2. 设置会显示运行状态、MCP 地址、HTTP API 地址和访问令牌。
3. 复制 MCP 配置到支持 Streamable HTTP 的 AI 客户端，即可连接。复制的配置已包含实际地址和访问令牌。

无需安装 Node.js、下载项目源码或运行命令。HTTP API 与 MCP 共用内置服务和访问令牌，开启 MCP 后即可使用。

服务仅监听本机 `127.0.0.1`，优先使用端口 `4318`；端口被占用时自动选择可用端口，请以 Setting 显示的地址为准。每次开启都会生成新的访问令牌，重新开启后需更新 AI 客户端中的配置。

关闭 Setting 后服务继续运行。关闭 MCP 开关或退出应用会停止服务；重新打开应用时默认关闭，按需开启。网页版无法运行此本地服务，需要使用桌面版。

## 数据与冲突

接口直接操作应用当前的排班文档，与界面共享同一份数据。外部写入通过校验并保存成功后才更新界面；整体替换文档使用与备份恢复相同的格式校验。

所有写入必须提供最近一次读取返回的 `revision`。文档变化后 revision 会更新，旧版本写入会被拒绝：HTTP 返回 409，MCP 返回 `isError: true`。重新读取最新数据后再提交修改。

应用正在编辑数据或生成排班时，外部写入也会暂时被拒绝（HTTP 409 / MCP 工具错误），避免覆盖尚未完成的操作。完成编辑或生成并返回排班日历后，重新读取数据并重试。

## HTTP

每个请求均需要 `Authorization: Bearer <访问令牌>`，请求体为 JSON。以下示例使用默认端口；实际地址和令牌可从 Setting 复制。

```bash
curl http://127.0.0.1:4318/api/state \
  -H 'Authorization: Bearer <访问令牌>'
```

| 方法与路径 | 请求体 / 返回 |
| --- | --- |
| `GET /api/state` | 返回当前文档 `{ revision, state }` |
| `PUT /api/state` | 请求 `{ revision, state }`，整体替换文档并返回新快照 |
| `POST /api/assignments` | 请求 `{ revision, employeeId, date, shiftId, locked? }`，更新一个人一天的排班 |
| `GET /api/validate` | 返回 `{ revision, issues }`，检查当前排班的规则冲突 |

单条排班使用 `shiftId: "off"` 表示休息；`remove: true` 删除该记录，删除时无需 shiftId。已锁定的单条排班必须显式提供 `unlock: true` 才可修改或删除。整体替换文档用于备份恢复和成员、班次、规则批量更新，会按提交的完整文档覆盖，包括锁定状态。

例如先读取 revision，然后修改一条排班：

```json
{
  "revision": "<最近读取到的 revision>",
  "employeeId": "employee-1",
  "date": "2026-10-15",
  "shiftId": "<已有班次 ID>",
  "locked": false
}
```

完整文档结构与应用导出的 JSON 备份一致。更新成员、班次或规则时先读取完整文档，仅修改需要的字段，再提交 PUT。无效日期、未知员工或班次、重复排班等会被拒绝；规则冲突可通过 validate 检查，手动排班仍允许保留待解决的规则冲突。

## MCP

服务提供无会话的 Streamable HTTP 端点 `/mcp`，通过 POST JSON-RPC 返回 JSON，不提供 SSE 订阅。客户端需支持自定义 Bearer 头。可直接复制 Setting 中的配置；以下为结构示例，具体字段依客户端而定：

```json
{
  "mcpServers": {
    "shift-schedule-expert": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer <访问令牌>" }
    }
  }
}
```

| 工具 | 参数 | 功能 |
| --- | --- | --- |
| `get_state` | `{}` | 获取完整文档和 revision |
| `replace_state` | `{ revision, state }` | 校验、保存并替换完整数据 |
| `set_assignment` | 同 HTTP 单条排班请求 | 新增、修改或删除单条排班 |
| `validate_schedule` | `{}` | 检查当前排班冲突 |
