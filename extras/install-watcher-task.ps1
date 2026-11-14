<#
.SYNOPSIS
  Registers the obsidian-rag-mcp watcher as a Windows Task Scheduler job that
  starts at logon.

.DESCRIPTION
  The task runs `node dist\cli.js watch` from the project directory and appends
  its output to a log file. Run this script again to update the task, or pass
  -Uninstall to remove it.

  Registering a task for the current user normally does not require an elevated
  PowerShell session. If registration fails with an access-denied error, run
  PowerShell as Administrator.

.PARAMETER TaskName
  Name of the scheduled task. Default: obsidian-rag-mcp-watcher.

.PARAMETER NodePath
  Path to node.exe. Default: the `node` executable found on PATH.

.PARAMETER LogPath
  Log file path. Default: %LOCALAPPDATA%\obsidian-rag-mcp\watcher.log.

.PARAMETER StartNow
  Start the task immediately after registering it.

.PARAMETER Uninstall
  Remove the scheduled task instead of registering it.

.EXAMPLE
  .\extras\install-watcher-task.ps1

.EXAMPLE
  .\extras\install-watcher-task.ps1 -StartNow

.EXAMPLE
  .\extras\install-watcher-task.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "obsidian-rag-mcp-watcher",
  [string]$NodePath,
  [string]$LogPath,
  [switch]$StartNow,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Task '$TaskName' is not registered."
    return
  }
  if ($PSCmdlet.ShouldProcess($TaskName, "Unregister scheduled task")) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  }
  return
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $projectRoot "dist\cli.js"
if (-not (Test-Path -LiteralPath $cliPath)) {
  throw "dist\cli.js was not found. Run 'npm run build' in $projectRoot first."
}

if (-not $NodePath) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "node was not found on PATH. Pass -NodePath explicitly."
  }
  $NodePath = $node.Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.js executable not found: $NodePath"
}

if (-not $LogPath) {
  $LogPath = Join-Path $env:LOCALAPPDATA "obsidian-rag-mcp\watcher.log"
}
$logDir = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$comspec = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot "System32\cmd.exe" }
$arguments = '/c ""{0}" "{1}" watch >> "{2}" 2>&1"' -f $NodePath, $cliPath, $LogPath
$action = New-ScheduledTaskAction -Execute $comspec -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive

if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task at logon")) {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "obsidian-rag-mcp watcher: auto-index note changes" `
    -Force | Out-Null

  Write-Host "Registered scheduled task '$TaskName'."
  Write-Host "  Command: $NodePath $cliPath watch"
  Write-Host "  Log:     $LogPath"

  if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started '$TaskName'."
  } else {
    Write-Host "It will start at the next logon. Run 'Start-ScheduledTask -TaskName $TaskName' to start it now."
  }
}
