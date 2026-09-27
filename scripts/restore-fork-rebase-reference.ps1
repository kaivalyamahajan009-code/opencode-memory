param(
  [string]$ForkRoot
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

. (Join-Path $PSScriptRoot "rebase-reference.ps1")

if (-not $ForkRoot) {
  $pluginRoot = Split-Path $PSScriptRoot -Parent
  $ForkRoot = Join-Path (Split-Path $pluginRoot -Parent) "opencode"
}
if (-not (Test-Path (Join-Path $ForkRoot ".git"))) {
  Write-Error "OpenCode fork not found at $ForkRoot"
  exit 1
}

Set-Location $ForkRoot

try {
  if (Test-GitRebaseInProgress) {
    throw "A rebase is still active. Continue it, or run git rebase --abort before restoring the local reference."
  }
  if (Restore-RebaseReference) {
    Write-Host "Restored the exact local reference bytes and skip-worktree bit; removed durable backup state."
  } else {
    Write-Host "No durable local-reference backup exists."
  }
} catch {
  Write-Error $_
  exit 1
}
