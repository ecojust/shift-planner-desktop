export type HttpApiDoc = {
  id: 'get-state' | 'put-state' | 'set-assignment' | 'validate'
  method: 'GET' | 'PUT' | 'POST'
  path: string
  title: string
  description: string
  parameters: Array<{ name: string; description: string }>
  body: string
  response: string
  language: 'curl' | 'JavaScript'
  example: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

const authorization = {
  name: 'Authorization（请求头，必填）',
  description: 'Bearer <HTTP 访问令牌>；使用 HTTP 服务的令牌，令牌无效返回 401。',
}
const revision = {
  name: 'revision（string，必填）',
  description: 'GET /api/state 返回的最新 revision。版本过期或应用正在编辑、生成排班时返回 409；完成操作后重新读取，再确认并提交修改。',
}
const writeResponse = '200：{ revision, state }，返回保存后的完整排班文档与版本；没有数据变化时返回当前快照。403 表示没有对应写入权限或修改了只读字段；409 表示版本冲突或应用忙碌，请重新读取后再确认修改。失败响应为 { "error": "错误说明" }。'

/** Generate display examples with a placeholder token, or copyable examples with the HTTP token. */
export function createHttpApiDocs(base: string, token: string): HttpApiDoc[] {
  const address = base.replace(/\/+$/, '')
  const curlGet = (path: string) => [
    'curl --fail-with-body --silent --show-error \\',
    '  --request GET \\',
    `  --header ${shellQuote(`Authorization: Bearer ${token}`)} \\`,
    `  ${shellQuote(address + path)}`,
  ].join('\n')
  const javascriptClient = `// 保存为 .mjs 文件，使用 Node.js 18+ 运行；先替换下方 REPLACE_ 占位符。
const base = ${JSON.stringify(address)};
const token = ${JSON.stringify(token)};

async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      Authorization: \`Bearer \${token}\`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}: \${result.error || response.statusText}\`);
  }
  return result;
}

// 403：在设置中检查对应写入权限；409：重新读取并确认修改后再提交。
// 示例不会自动重试写入。`

  return [
    {
      id: 'get-state', method: 'GET', path: '/api/state', title: '读取排班数据',
      description: '读取当前应用的完整排班文档与 revision。写入前先调用本接口。',
      parameters: [authorization, { name: '请求参数', description: '无请求体，无查询参数。' }],
      body: '',
      response: '200：{ revision, state }。revision 是版本字符串；state 是完整文档，包含成员 employees、班次 shifts、规则 rules、排班 assignments 及其他已保存字段。失败响应为 { "error": "错误说明" }。',
      language: 'curl',
      example: curlGet('/api/state'),
    },
    {
      id: 'put-state', method: 'PUT', path: '/api/state', title: '更新完整排班文档',
      description: '先读取完整 state，再修改目标字段并整体提交。只允许修改设置中已授权的成员、班次、规则和排班数据；其他字段保留原值。示例修改指定成员的岗位，需要“成员”写入权限。',
      parameters: [authorization, revision, {
        name: 'state（object，必填）',
        description: '同次 GET /api/state 返回的完整 state 对象。保留所有未修改字段和集合；不能只提交部分成员或局部字段。来源记录由应用维护。',
      }],
      body: '{\n  "revision": "REPLACE_WITH_LATEST_REVISION",\n  "state": <GET /api/state 返回的完整 state 对象，仅修改目标字段>\n}\n\n以上为结构示意；state 必须为完整对象。下方 JavaScript 示例会构造实际 JSON 请求体。',
      response: writeResponse,
      language: 'JavaScript',
      example: `${javascriptClient}
const { revision, state } = await request('/api/state');
const employeeId = 'REPLACE_EMPLOYEE_ID';
if (employeeId.startsWith('REPLACE_')) throw new Error('请将 employeeId 替换为目标成员的实际 ID');
const employee = state.employees.find(item => item.id === employeeId);
if (!employee) throw new Error('目标成员不存在，请重新读取成员列表并检查 employeeId');
employee.role = '值班主管';

const saved = await request('/api/state', {
  method: 'PUT',
  body: JSON.stringify({ revision, state }),
});
console.log(saved); // { revision, state }：保存后的完整快照`,
    },
    {
      id: 'set-assignment', method: 'POST', path: '/api/assignments', title: '设置单条排班',
      description: '设置或删除指定成员在指定日期的排班，需要“排班结果”写入权限。示例将指定日期设为休息；请替换成员 ID 和日期。',
      parameters: [authorization, revision, {
        name: 'employeeId（string，必填）', description: '现有成员的 ID，来自 state.employees。',
      }, {
        name: 'date（string，必填）', description: '实际日期，格式 YYYY-MM-DD，年份为 0001–9999。',
      }, {
        name: 'shiftId（string）', description: '现有班次 ID，或用 off 表示休息；remove 不为 true 时必填。',
      }, {
        name: 'locked（boolean，可选）', description: '新排班是否锁定，默认为 false；修改原来锁定的排班仍需显式提供 unlock: true。',
      }, {
        name: 'remove（boolean，可选）', description: '设为 true 删除该成员该日期的排班，此时无需 shiftId；默认 false。',
      }, {
        name: 'unlock（boolean，可选）', description: '设为 true 才允许修改或删除原来锁定的排班；默认不解锁。写入后是否锁定由 locked 决定。',
      }],
      body: JSON.stringify({ revision: 'REPLACE_WITH_LATEST_REVISION', employeeId: 'REPLACE_EMPLOYEE_ID', date: 'REPLACE_YYYY_MM_DD', shiftId: 'off', locked: false, remove: false, unlock: false }, null, 2),
      response: writeResponse + ' 参数、日期、成员或班次无效，以及未授权解锁已有锁定排班时返回 400。',
      language: 'JavaScript',
      example: `${javascriptClient}
const { revision, state } = await request('/api/state');
const employeeId = 'REPLACE_EMPLOYEE_ID';
const date = 'REPLACE_YYYY_MM_DD';
const shiftId = 'off'; // 休息；可改为 state.shifts 中的班次 ID。
if (employeeId.startsWith('REPLACE_')) throw new Error('请替换目标成员的实际 ID');
if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || date.startsWith('0000-')) {
  throw new Error('请将 date 替换为实际日期，格式 YYYY-MM-DD');
}
if (!state.employees.some(item => item.id === employeeId)) throw new Error('目标成员不存在');
if (shiftId !== 'off' && !state.shifts.some(item => item.id === shiftId)) throw new Error('目标班次不存在');

const saved = await request('/api/assignments', {
  method: 'POST',
  body: JSON.stringify({ revision, employeeId, date, shiftId, locked: false, remove: false, unlock: false }),
});
console.log(saved); // { revision, state }：保存后的完整快照`,
    },
    {
      id: 'validate', method: 'GET', path: '/api/validate', title: '检查排班问题',
      description: '检查当前排班中的错误和提醒，返回问题列表，不修改排班数据。',
      parameters: [authorization, { name: '请求参数', description: '无请求体，无查询参数。' }],
      body: '',
      response: '200：{ revision, issues }。issues 为问题数组；每项包含 id、type、severity（error 或 warning）、message，可附带 date、employeeId、shiftId、suggestion、target。没有问题时为 []。失败响应为 { "error": "错误说明" }。',
      language: 'curl',
      example: curlGet('/api/validate'),
    },
  ]
}
