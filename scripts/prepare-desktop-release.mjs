import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBuildVersion } from './build-version.ts';

export function prepareRelease(root = process.cwd(), env = process.env) {
  const commit = env.GITHUB_SHA;
  const runId = env.GITHUB_RUN_ID;
  const buildVersion = validateBuildVersion(env.SHIFT_FLOW_BUILD_VERSION);
  assert.match(commit || '', /^[a-f0-9]{40}$/);
  assert.match(runId || '', /^\d+$/);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/);
  const directory = join(root, 'artifacts');
  const platforms = [
    { id: 'windows-x64', target: 'x86_64-pc-windows-msvc', extension: 'exe' },
    { id: 'macos-x64', target: 'x86_64-apple-darwin', extension: 'dmg' },
    { id: 'macos-arm64', target: 'aarch64-apple-darwin', extension: 'dmg' },
  ];
  const names = ['shift-planner-source.zip'];
  const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  for (const { id, target, extension } of platforms) {
    const nativeName = `${id}-native-validation.json`;
    const monthName = `${id}-month-schedule-validation.json`;
    const manifestName = `${id}-solver-manifest.json`;
    const native = read(nativeName);
    const month = read(monthName);
    const solver = read(manifestName);
    assert.equal(native.target, target);
    assert.equal(native.commit, commit, `${id}: different native build commit`);
    assert.equal(native.buildVersion, buildVersion, `${id}: different UI build number`);
    assert.equal(native.checkedInstalledResourceLayout, true);
    assert.equal(native.info.engine, 'ortools-cp-sat');
    assert.equal(native.selfTest.status, 'OPTIMAL');
    assert.equal(native.selfTest.selfTest, true);
    assert.equal(solver.target, target);
    assert.equal(solver.format, 'onedir');
    assert.equal(solver.solverInfo.version, native.info.version);
    assert.equal(month.buildCommit, commit, `${id}: different month test commit`);
    assert.equal(String(month.buildRun), runId, `${id}: different build run`);
    assert.equal(month.buildVersion, buildVersion, `${id}: different month validation build number`);
    assert.equal(month.target, target);
    assert.equal(month.checkedAppRuntime, true);
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(month.status));
    assert.ok(month.assignmentCount >= 155, `${id}: minimum coverage requires at least 155 assignments`);
    assert.equal(month.shortageCount, 0);
    assert.deepEqual(month.independentRuleIssues, []);
    if (extension === 'dmg') {
      const auditName = `${id}-macos-app-audit.json`;
      const audit = read(auditName);
      assert.equal(audit.target_architecture, id === 'macos-arm64' ? 'arm64' : 'x86_64');
      assert.equal(audit.validation.passed, true);
      assert.deepEqual(audit.validation.errors, []);
      assert.equal(audit.summary.all_macho_objects_contain_target_architecture, true);
      assert.equal(audit.summary.all_symlinks_internal_and_resolvable, true);
      assert.equal(audit.minimum_system_assessment.declaration_understates_observed_minimum, false);
      const signature = read(`${id}-macos-signature-validation.json`);
      assert.equal(signature.commit, commit);
      assert.equal(String(signature.buildRun), runId);
      assert.equal(signature.passed, true);
      assert.equal(signature.sealedResourcesVerified, true);
      assert.equal(signature.allNativeObjectsVerified, true);
      assert.equal(signature.checks.pythonFramework.strictDeepVerified, true);
    }
    const installer = `shift-schedule-expert-${id}.${extension}`;
    const bytes = readFileSync(join(directory, installer));
    assert.ok(bytes.length > 512, `Empty installer: ${installer}`);
    if (extension === 'exe') assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
    else assert.equal(bytes.subarray(-512, -508).toString(), 'koly');
    // Reports remain required evidence above and stay in Actions artifacts.
    // Public downloads contain only installers, exact source and checksums.
    names.push(installer);
  }
  assert.equal(readFileSync(join(directory, 'shift-planner-source.zip')).subarray(0, 4).toString('hex'), '504b0304');
  const describe = name => {
    const bytes = readFileSync(join(directory, name));
    assert.ok(bytes.length > 0, `Empty attachment: ${name}`);
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const files = names.sort().map(describe);
  writeFileSync(join(directory, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
  files.push(describe('SHA256SUMS'));
  const notes = `Shift Schedule Expert ${version} · Windows 与 macOS 桌面版

本版增加自动排班规则检查：切换月份、调整配置或排班，以及 MCP / HTTP 生成结束后，都会检查当前保存的排班并显示结果。

- 日历上方明确显示「符合规则」或「不符合规则」，直接列出具体原因；岗位缺人也视为不符合。
- 跨月历史不完整或相邻月份尚未排班时显示「跨月规则待核对」，保留具体原因；尚未排班的空月份不会误报符合规则。
- 检查在后台运行，期间显示加载动画；快速切换月份会取消旧检查，旧结果不会覆盖当前月份。
- 配置变更后按当前规则重新检查，既有修改来源和时间保持不变；检查失败时可重试。
- MCP / HTTP 生成成功、返回相同排班或生成失败保留原表后，都会重新检查。外部返回增加 validation，区分实际保存排班的规则检查与求解失败诊断。
- 外部指定其他月份时，校验目标月份并保留当前页面月份；取消、权限变化或数据变化会阻止过期结果保存。
- 月份选择器异步更新可见月份的规则状态，避免检查阻塞界面。
- 保留完整自然周、排班休息与主动请假的区分、人员排序、实时方案计数以及侧栏折叠。

发布流程要求三个平台的前端回归、类型检查、Vue 构建、Python OR-Tools 约束测试、Rust 进程与内置 MCP/HTTP 服务测试及真实求解集成全部通过，并校验最终安装包中的求解器资源后才公开下载文件。具体原生验证范围见下文。

按电脑类型选择一个安装包，无需下载全部文件：

| 电脑 | 安装包 |
| --- | --- |
| Windows 10/11，Intel/AMD 64 位 | shift-schedule-expert-windows-x64.exe |
| Intel Mac，macOS 14+ | shift-schedule-expert-macos-x64.dmg |
| M 系列 Mac，macOS 14+ | shift-schedule-expert-macos-arm64.dmg |

Windows 在 Windows Server 2022 x64 云端构建机上完成 NSIS 静默安装和包内求解验证；两个 Mac 版本分别在 macOS 15 Intel/Apple Silicon 原生构建并验证最终 App。三个版本均已完成前端、Python、Rust 与真实集成检查，固定津贴计算、备份和 Excel 导出包含在前端回归中。各平台还使用最终安装包资源目录中的 OR-Tools 完成以下验证：

- 12 人整月覆盖测试明确将每人周最低工时设为 0，覆盖至少 155 个班位、零缺员；并验证下一月未知日期的临时覆盖真实可行，临时排班不进入正式结果。
- 使用 12 人每周最低 40、最高 48 小时与整周固定班次容量冲突的独立测试，要求求解器正确返回 INFEASIBLE，且不返回替代排班。
- 另用 2 人模型设置每人周最低 14 小时及周末 40% 的星期权重，保留两侧邻月已有的真实排班；对首尾完整自然周及月内完整周逐一核对实际工时、人次份额、组内均摊和最低人数，不预设固定的整月班次数。

以上验证不包含各版本桌面系统的人工界面操作测试。

安装包自带 Python 和 OR-Tools，本地求解无需另外安装 Python。Windows 使用系统 WebView2，缺少时安装程序可能需要联网补装。

Mac App 和内置 Python 框架已完成 ad-hoc 签名及资源封印，并逐一严格验证原生代码。ad-hoc 不等于 Apple Developer ID 签名或 Apple 公证；首次运行仍可能需要在「系统设置 → 隐私与安全性」中对本应用选择「仍要打开」。Windows 未配置发行代码签名。Mac 依赖最低版本已审计为不高于应用声明的 macOS 14。

shift-planner-source.zip 是本次构建的精确源码；SHA256SUMS 用于校验下载文件。JSON 验证报告保留在下方构建记录的 Actions Artifacts 中，按平台归档，保留 14 天。

构建号：${buildVersion}（北京时间）
源码提交：${commit}
构建记录：https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${runId}
`;
  writeFileSync(join(root, 'desktop-release-notes.md'), notes);
  const result = { schemaVersion: 1, commit, runId, version, buildVersion, tag: `desktop-v${version}-${runId}`, files };
  writeFileSync(join(root, 'desktop-release-manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareRelease(), null, 2));
}
