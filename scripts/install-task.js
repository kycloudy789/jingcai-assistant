#!/usr/bin/env node
/**
 * 注册 / 移除 Windows 计划任务：每天开奖后自动抓数据并发布。
 *
 * 为什么需要它：GitHub 托管的 Actions 机器抓福彩网会被 WAF 按 IP 拦（403），
 * 所以"每天自动更新"只能在本机做。
 *
 * 用法：
 *   node scripts/install-task.js            # 安装（每天 21:50 跑一次）
 *   node scripts/install-task.js --remove   # 移除
 *   node scripts/install-task.js --dry-run  # 只打印将执行的命令
 */
const path = require('path');
const { execFileSync } = require('child_process');

const TASK_NAME = 'JingcaiDailyDrawSync';
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'publish-data.js');
const NODE = process.execPath;

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const dryRun = args.includes('--dry-run');

function runPowerShell(command) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    stdio: dryRun ? 'pipe' : 'inherit',
  });
}

if (process.platform !== 'win32') {
  console.error('这个脚本只处理 Windows 计划任务；macOS/Linux 请用 cron。');
  process.exit(1);
}

if (remove) {
  const cmd = `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`;
  if (dryRun) {
    console.log(cmd);
    process.exit(0);
  }
  try {
    runPowerShell(cmd);
    console.log(`已移除计划任务：${TASK_NAME}`);
  } catch (err) {
    console.error(`移除失败（可能本来就不存在）：${err.message}`);
  }
  process.exit(0);
}

// 统一 21:50：双色球 21:15 开奖、快乐8 21:30 开奖，21:50 时两彩种都已出公告。
const ps = [
  "$ErrorActionPreference='Stop'",
  `$action = New-ScheduledTaskAction -Execute '${NODE}' -Argument '"${SCRIPT}" --count 10 --keep 3000'`,
  '$t1 = New-ScheduledTaskTrigger -Daily -At 21:50',
  '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew',
  `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger @($t1) -Settings $settings -Description '竞彩助手：每天开奖后抓取开奖数据并发布到 GitHub Pages' -Force | Out-Null`,
  `Get-ScheduledTask -TaskName '${TASK_NAME}' | Select-Object TaskName,State | Format-List`,
].join('; ');

if (dryRun) {
  console.log(ps);
  process.exit(0);
}

try {
  runPowerShell(ps);
  console.log(`
✓ 已安装计划任务：${TASK_NAME}
  时间：每天 21:50（错过会尽快补跑）
  命令：${NODE} "${SCRIPT}" --count 10 --keep 3000
  数据无变化时不会产生空提交。

  查看：Get-ScheduledTask -TaskName ${TASK_NAME}
  立即跑一次：Start-ScheduledTask -TaskName ${TASK_NAME}
  移除：node scripts/install-task.js --remove
`);
} catch (err) {
  console.error(`✗ 安装失败：${err.message}`);
  console.error('可以手动在「任务计划程序」里创建：程序填 node.exe，参数填脚本路径。');
  process.exit(1);
}
