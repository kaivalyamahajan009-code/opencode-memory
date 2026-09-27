$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

. (Join-Path (Split-Path $PSScriptRoot -Parent) "rebase-git.ps1")
. (Join-Path (Split-Path $PSScriptRoot -Parent) "rebase-reference.ps1")

function Invoke-TestGit {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = @(& git @Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  $output
}

function Read-OneGitLine {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = @(Invoke-TestGit -Arguments $Arguments)
  if ($output.Count -ne 1) {
    throw "Expected one line from git $($Arguments -join ' '), got $($output.Count)."
  }
  [string]$output[0]
}

function Read-GitText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  [string]::Join("`n", @(Invoke-TestGit -Arguments $Arguments))
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)]$Actual,
    [Parameter(Mandatory = $true)]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Actual -cne $Expected) {
    throw "$Label mismatch. Expected '$Expected', got '$Actual'."
  }
}

function Assert-BytesEqual {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Actual,
    [Parameter(Mandatory = $true)][byte[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (
    [System.Convert]::ToBase64String($Actual) -cne
    [System.Convert]::ToBase64String($Expected)
  ) {
    throw "$Label byte mismatch."
  }
}

function New-TestCommit {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$Message,
    [Parameter(Mandatory = $true)][string]$AuthorName,
    [Parameter(Mandatory = $true)][string]$AuthorEmail,
    [Parameter(Mandatory = $true)][string]$CommitterName,
    [Parameter(Mandatory = $true)][string]$CommitterEmail
  )

  [System.IO.File]::WriteAllText($Path, $Content)
  Invoke-TestGit -Arguments @("add", "--", $Path) | Out-Null

  $identityKeys = @("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")
  $savedIdentity = @{}
  foreach ($key in $identityKeys) {
    $savedIdentity[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
  }
  try {
    $env:GIT_AUTHOR_NAME = $AuthorName
    $env:GIT_AUTHOR_EMAIL = $AuthorEmail
    $env:GIT_COMMITTER_NAME = $CommitterName
    $env:GIT_COMMITTER_EMAIL = $CommitterEmail
    Invoke-TestGit -Arguments @("commit", "--quiet", "-m", $Message) | Out-Null
  } finally {
    foreach ($key in $identityKeys) {
      [Environment]::SetEnvironmentVariable($key, $savedIdentity[$key], "Process")
    }
  }

  Read-OneGitLine -Arguments @("rev-parse", "HEAD")
}

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("opencode-memory-rebase-" + [guid]::NewGuid().ToString("N"))
$repo = Join-Path $temporary "repo"
$globalConfig = Join-Path $temporary "global.gitconfig"
$originalLocation = Get-Location
$environmentKeys = @("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME")
$savedEnvironment = @{}
foreach ($key in $environmentKeys) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
}

try {
  New-Item -ItemType Directory -Path $repo -Force | Out-Null
  $env:GIT_CONFIG_GLOBAL = $globalConfig
  $env:GIT_CONFIG_NOSYSTEM = "1"
  $env:GIT_TERMINAL_PROMPT = "0"
  $env:HOME = $temporary

  Invoke-TestGit -Arguments @("init", "--quiet", "--initial-branch=main", $repo) | Out-Null
  Set-Location $repo

  $referenceRelative = "packages/app/src/custom-elements.d.ts"
  $referencePath = Join-Path $repo $referenceRelative
  $referenceDirectory = Split-Path $referencePath -Parent
  New-Item -ItemType Directory -Path $referenceDirectory -Force | Out-Null
  $basePayload = [System.Text.Encoding]::UTF8.GetBytes("../../ui/src/custom-elements.d.ts")
  $basePayloadPath = Join-Path $temporary "base-symlink-payload.bin"
  [System.IO.File]::WriteAllBytes($basePayloadPath, $basePayload)
  $baseBlob = Read-OneGitLine -Arguments @("hash-object", "-w", $basePayloadPath)
  Invoke-TestGit -Arguments @(
    "update-index",
    "--add",
    "--cacheinfo",
    "120000,$baseBlob,$referenceRelative"
  ) | Out-Null
  $conflictPath = Join-Path $repo "conflict.txt"
  [System.IO.File]::WriteAllText($conflictPath, "base`n")
  Invoke-TestGit -Arguments @("add", "--", $conflictPath) | Out-Null

  $base = New-TestCommit `
    -Path (Join-Path $repo "base.txt") `
    -Content "base`n" `
    -Message "base" `
    -AuthorName "Upstream Author" `
    -AuthorEmail "upstream-author@example.invalid" `
    -CommitterName "Upstream Committer" `
    -CommitterEmail "upstream-committer@example.invalid"

  [System.IO.File]::WriteAllText($conflictPath, "upstream`n")
  Invoke-TestGit -Arguments @("add", "--", $conflictPath) | Out-Null
  $newBase = New-TestCommit `
    -Path (Join-Path $repo "upstream.txt") `
    -Content "upstream`n" `
    -Message "upstream change" `
    -AuthorName "Upstream Author" `
    -AuthorEmail "upstream-author@example.invalid" `
    -CommitterName "Upstream Committer" `
    -CommitterEmail "upstream-committer@example.invalid"

  $generatedReplacement = [System.Text.Encoding]::UTF8.GetBytes(
    "/// <reference path=`"../../ui/src/custom-elements.d.ts`" />`r`n"
  )
  [System.IO.File]::WriteAllBytes($referencePath, $generatedReplacement)
  Invoke-TestGit -Arguments @("update-index", "--skip-worktree", "--", $referenceRelative) | Out-Null
  if (-not (Test-RebaseReferenceSkipped -RelativePath $referenceRelative)) {
    throw "The fixture reference was not marked skip-worktree."
  }

  Invoke-TestGit -Arguments @("switch", "--quiet", "-c", "feature", $base) | Out-Null
  [System.IO.File]::WriteAllText($conflictPath, "feature`n")
  Invoke-TestGit -Arguments @("add", "--", $conflictPath) | Out-Null
  $oldFeature = New-TestCommit `
    -Path (Join-Path $repo "feature.txt") `
    -Content "feature`n" `
    -Message "feature change" `
    -AuthorName "Feature Author" `
    -AuthorEmail "feature-author@example.invalid" `
    -CommitterName "Stack Committer" `
    -CommitterEmail "stack-committer@example.invalid"

  Invoke-TestGit -Arguments @("switch", "--quiet", "-c", "memory") | Out-Null
  $topPayload = [System.Text.Encoding]::UTF8.GetBytes(
    "/// <reference path=`"../../ui/src/custom-elements.d.ts`" />`n"
  )
  $topPayloadPath = Join-Path $temporary "top-symlink-payload.bin"
  [System.IO.File]::WriteAllBytes($topPayloadPath, $topPayload)
  $topBlob = Read-OneGitLine -Arguments @("hash-object", "-w", $topPayloadPath)
  Invoke-TestGit -Arguments @("update-index", "--no-skip-worktree", "--", $referenceRelative) | Out-Null
  Invoke-TestGit -Arguments @("update-index", "--cacheinfo", "120000,$topBlob,$referenceRelative") | Out-Null
  Invoke-TestGit -Arguments @("update-index", "--skip-worktree", "--", $referenceRelative) | Out-Null
  $oldTop = New-TestCommit `
    -Path (Join-Path $repo "memory.txt") `
    -Content "memory`n" `
    -Message "memory change" `
    -AuthorName "Memory Author" `
    -AuthorEmail "memory-author@example.invalid" `
    -CommitterName "Stack Committer" `
    -CommitterEmail "stack-committer@example.invalid"

  [System.IO.File]::WriteAllBytes($referencePath, $generatedReplacement)
  Invoke-TestGit -Arguments @("update-index", "--skip-worktree", "--", $referenceRelative) | Out-Null

  $identity = Get-RebaseCommitterIdentity -Ref $oldTop
  $emptyIdentityRejected = $false
  try {
    Invoke-GitWithRebaseIdentity `
      -Identity ([pscustomobject]@{ Name = ""; Email = "nobody@example.invalid" }) `
      -Arguments @("status", "--short") | Out-Null
  } catch {
    $emptyIdentityRejected = $true
  }
  if (-not $emptyIdentityRejected) {
    throw "The identity-scoped Git helper accepted an empty committer name."
  }

  if (-not (Prepare-RebaseReference -RelativePath $referenceRelative)) {
    throw "The regular skip-worktree reference was not prepared."
  }
  if (-not (Test-RebaseReferenceState)) {
    throw "Preparing the reference did not create durable Git-dir state."
  }
  if (Test-RebaseReferenceSkipped -RelativePath $referenceRelative) {
    throw "Preparing the reference did not clear skip-worktree."
  }
  Assert-BytesEqual `
    -Actual ([System.IO.File]::ReadAllBytes($referencePath)) `
    -Expected $topPayload `
    -Label "prepared index payload"
  $staleStateRejected = $false
  try {
    Prepare-RebaseReference -RelativePath $referenceRelative | Out-Null
  } catch {
    $staleStateRejected = $true
  }
  if (-not $staleStateRejected) {
    throw "Preparing the reference overwrote an existing durable backup."
  }

  Invoke-GitWithRebaseIdentity `
    -Identity $identity `
    -Arguments @("rebase", "--update-refs", "--onto", $newBase, $base) `
    -NonInteractive
  if ($LASTEXITCODE -eq 0 -or -not (Test-GitRebaseInProgress)) {
    throw "The fixture rebase did not stop on its expected content conflict."
  }
  if (-not (Assert-RebaseReferencePrepared)) {
    throw "The durable reference state disappeared while the rebase was stopped."
  }
  if (Test-RebaseReferenceSkipped -RelativePath $referenceRelative) {
    throw "A stopped rebase restored skip-worktree too early."
  }
  $activeRestoreRejected = $false
  try {
    Restore-RebaseReference | Out-Null
  } catch {
    $activeRestoreRejected = $true
  }
  if (-not $activeRestoreRejected) {
    throw "Reference restoration was allowed during an active rebase."
  }

  [System.IO.File]::WriteAllText($conflictPath, "resolved`n")
  Invoke-TestGit -Arguments @("add", "--", $conflictPath) | Out-Null
  $continueScript = Join-Path (Split-Path $PSScriptRoot -Parent) "continue-fork-rebase.ps1"
  & powershell `
    -NoProfile `
    -ExecutionPolicy Bypass `
    -File $continueScript `
    -IdentityRef $oldTop `
    -ForkRoot $repo
  if ($LASTEXITCODE -ne 0) {
    throw "The conflict continuation helper failed with exit code $LASTEXITCODE."
  }
  if (Test-GitRebaseInProgress) {
    throw "The continuation helper left the rebase active."
  }

  Assert-BytesEqual `
    -Actual ([System.IO.File]::ReadAllBytes($referencePath)) `
    -Expected $generatedReplacement `
    -Label "restored generated replacement"
  if (-not (Test-RebaseReferenceSkipped -RelativePath $referenceRelative)) {
    throw "Final reference restoration did not restore skip-worktree."
  }
  if (Test-RebaseReferenceState) {
    throw "Final reference restoration left stale durable state."
  }
  $finalReference = Get-RebaseReferenceIndexEntry -RelativePath $referenceRelative
  Assert-Equal -Actual $finalReference.Mode -Expected "120000" -Label "final reference mode"

  $newFeature = Read-OneGitLine -Arguments @("rev-parse", "refs/heads/feature")
  $newTop = Read-OneGitLine -Arguments @("rev-parse", "refs/heads/memory")
  Assert-Equal `
    -Actual (Read-OneGitLine -Arguments @("rev-parse", "$newFeature^")) `
    -Expected $newBase `
    -Label "feature parent"
  Assert-Equal `
    -Actual (Read-OneGitLine -Arguments @("rev-parse", "$newTop^")) `
    -Expected $newFeature `
    -Label "memory parent"

  foreach ($pair in @(@($oldFeature, $newFeature), @($oldTop, $newTop))) {
    Assert-Equal `
      -Actual (Read-OneGitLine -Arguments @("show", "-s", "--format=%an", $pair[1])) `
      -Expected (Read-OneGitLine -Arguments @("show", "-s", "--format=%an", $pair[0])) `
      -Label "author name"
    Assert-Equal `
      -Actual (Read-OneGitLine -Arguments @("show", "-s", "--format=%ae", $pair[1])) `
      -Expected (Read-OneGitLine -Arguments @("show", "-s", "--format=%ae", $pair[0])) `
      -Label "author email"
    Assert-Equal `
      -Actual (Read-GitText -Arguments @("show", "-s", "--format=%B", $pair[1])) `
      -Expected (Read-GitText -Arguments @("show", "-s", "--format=%B", $pair[0])) `
      -Label "commit message"
    Assert-Equal `
      -Actual (Read-OneGitLine -Arguments @("show", "-s", "--format=%cn", $pair[1])) `
      -Expected "Stack Committer" `
      -Label "committer name"
    Assert-Equal `
      -Actual (Read-OneGitLine -Arguments @("show", "-s", "--format=%ce", $pair[1])) `
      -Expected "stack-committer@example.invalid" `
      -Label "committer email"
  }

  $localIdentity = @(& git config --local --get-regexp "^user\." 2>$null)
  if ($LASTEXITCODE -ne 1 -or $localIdentity.Count -ne 0) {
    throw "The rebase wrote local user identity configuration."
  }
  if (Test-Path -LiteralPath $globalConfig) {
    throw "The rebase wrote global Git configuration."
  }

  Write-Host "PASS: stacked rebase preserved identity/messages, restored exact skip-worktree bytes/S, and wrote no Git config."
} finally {
  Set-Location $originalLocation
  foreach ($key in $environmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], "Process")
  }
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -Recurse -Force -LiteralPath $temporary
  }
}
