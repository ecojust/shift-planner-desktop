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
    assert.equal(month.assignmentCount, 155);
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
    const installer = `shift-flow-${id}.${extension}`;
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
  const notes = `排班 plus ${version} · Windows 与 macOS 测试发行版

本版优化成员管理：月最低、周最低和周最高工时直接在成员卡片填写，可上班次直接点选标签；修改后在卡片保存或取消，无需展开人员编辑。请假改为独立日历弹窗，点击日期多选，支持切月与清空本月，取消不会改动原记录。已有排班和锁定记录会保留，请假冲突可在排班日历中检查。

继续支持员工月最低工时、周最低／最高工时，以及可按月份调整的参考工时。月参考默认按日历工作日 × 8 小时计算，个人可跟随参考值或单独设置；月工时按实际时段拆分跨月班次，月初和月末不足一周的周最低工时按本月天数折算。最低工时属于硬约束，允许缺员也不会放宽；不可行时保留原排班。

星期上班权重：选择星期和比例后，将每周班次名额按所选星期与其余星期分配，并在各组日期间尽量均匀安排。月初、月末保留本月日期对应的配额，实际整数班次以界面显示的配额范围为准；班次资格、请假、休息间隔和工时限制仍同时生效。

班次津贴改为固定的「元／人／班」：每排一次领取一份，跨夜全部归属开始日期，跨月不拆分金额；工资、节假日、倍率和班次时长不改变津贴。排班格子的金色金额、每日及成员月汇总随安排同步更新，Excel 导出使用相同计算结果并附班次金额和津贴明细。金额按整数分累计，支持最多两位小数。已有本地排班和备份继续兼容；右上角保留固定的北京时间构建号。

按电脑类型选择一个安装包，无需下载全部文件：

| 电脑 | 安装包 |
| --- | --- |
| Windows 10/11，Intel/AMD 64 位 | shift-flow-windows-x64.exe |
| Intel Mac，macOS 14+ | shift-flow-macos-x64.dmg |
| M 系列 Mac，macOS 14+ | shift-flow-macos-arm64.dmg |

Windows 在 Windows Server 2022 x64 云端构建机上完成 NSIS 静默安装和包内求解验证；两个 Mac 版本分别在 macOS 15 Intel/Apple Silicon 原生构建并验证最终 App。三个版本均已完成前端、Python、Rust 与真实集成检查，固定津贴计算、备份和 Excel 导出包含在前端回归中。各平台还使用最终安装包资源目录中的 OR-Tools 完成以下验证：

- 12 人整月覆盖测试明确将每人月／周最低工时设为 0，得到 155 个班位、零缺员，独立规则复核零问题。这是覆盖测试条件，不表示默认参考工时下的示例可行。
- 同一示例跟随 2026 年 10 月每人 144 小时的月参考值时，最低工时合计超过班次容量，正确返回 INFEASIBLE，并且不返回替代排班。
- 另用 2 人模型同时设置每人月最低 120 小时、周最低 14 小时及周末 40% 的星期权重，真实求解得到 32 个班位、零缺员；月／周工时、月首尾不足周的配额及所选星期名额均通过独立规则复核。

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
