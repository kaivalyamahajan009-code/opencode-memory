param(
  [Parameter(Mandatory = $true)]
  [string]$IdentityRef,
  [string]$ForkRoot
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

. (Join-Path $PSScriptRoot "rebase-git.ps1")
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

$rebaseMerge = git rev-parse --git-path rebase-merge
if ($LASTEXITCODE -ne 0) {
  Write-Error "Could not inspect the rebase state in $ForkRoot"
  exit 1
}
$rebaseApply = git rev-parse --git-path rebase-apply
if ($LASTEXITCODE -ne 0) {
  Write-Error "Could not inspect the rebase state in $ForkRoot"
  exit 1
}
if (-not (Test-Path $rebaseMerge) -and -not (Test-Path $rebaseApply)) {
  Write-Error "No rebase is in progress in $ForkRoot"
  exit 1
}

try {
  Assert-RebaseReferencePrepared | Out-Null
  $identity = Get-RebaseCommitterIdentity -Ref $IdentityRef
  Invoke-GitWithRebaseIdentity -Identity $identity -Arguments @("rebase", "--continue") -NonInteractive
  $code = $LASTEXITCODE
} catch {
  Write-Error $_
  exit 1
}

if ($code -eq 0 -and -not (Test-GitRebaseInProgress)) {
  try {
    if (Restore-RebaseReference) {
      Write-Host "Restored the local skip-worktree reference and removed its durable backup."
    }
  } catch {
    $restoreScript = Join-Path $PSScriptRoot "restore-fork-rebase-reference.ps1"
    Write-Error "Rebase finished, but reference restoration failed: $_ Run '$restoreScript' after confirming no rebase is active."
    exit 1
  }
} elseif (Test-RebaseReferenceState) {
  Write-Host "Rebase is still stopped; the durable local-reference backup remains prepared for the next continuation."
}

exit $code
