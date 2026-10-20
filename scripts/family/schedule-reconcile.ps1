# Registers (or updates) the nightly family reconciliation as a Windows scheduled task for the
# current user: `npm run family:reconcile` every night, output appended to
# var/family-reconcile/nightly.log (git-ignored). Exit code 2 (drift) shows as the task's
# "Last Run Result". On Linux hosts use cron instead (docs/family/reconcile-runbook.md).
#
#   powershell -File scripts/family/schedule-reconcile.ps1 [-At 02:30]
#   Unregister-ScheduledTask -TaskName 'Tendi family reconcile' -Confirm:$false   # to remove

param(
  [string]$At = '02:30',
  [string]$TaskName = 'Tendi family reconcile'
)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$logDir = Join-Path $root 'var\family-reconcile'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$command = "cd /d `"$root`" && npm run --silent family:reconcile >> `"$logDir\nightly.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $command"
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Family module nightly reconciliation (Tendi-new-API, scripts/family/reconcile.ts). Read-only apart from family_reconcile_runs.' `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, @{ n = 'NextRun'; e = { (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime } }
