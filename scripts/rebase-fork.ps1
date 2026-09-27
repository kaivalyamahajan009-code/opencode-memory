param(
  [Parameter(Mandatory = $true)]
  [string]$Tag,
  # Stacked branches, bottom first. Each must be an ancestor of the next.
  [string[]]$Branches = @("feat/inline-svg-and-latex", "memory-tab"),
  # Upstream commit the bottom branch currently sits on. Defaults to its merge-base with upstream/$UpstreamBranch.
  [string]$OldBase,
  [string]$UpstreamBranch = "dev",
  # Refuse to continue if more commits than this would be replayed (guards against a wrong base).
  [int]$MaxCommits = 20
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

. (Join-Path $PSScriptRoot "rebase-git.ps1")
. (Join-Path $PSScriptRoot "rebase-reference.ps1")

$script:referencePrepared = $false
$script:rebaseStarted = $false

function Fail([string]$Message, [int]$Code = 1) {
  if ($Code -eq 0) { $Code = 1 }
  Write-Host $Message -ForegroundColor Red
  Exit-Script $Code
}

function Exit-Script([int]$Code) {
  if ($script:referencePrepared -and -not $script:rebaseStarted) {
    try {
      Restore-RebaseReference | Out-Null
      $script:referencePrepared = $false
    } catch {
      Write-Host "Failed to restore the durable skip-worktree reference backup: $_" -ForegroundColor Red
      if ($script:rebaseStamp) { Write-Recovery $script:rebaseStamp }
      exit 1
    }
  }
  exit $Code
}

function Write-Recovery([string]$Stamp) {
  $restoreScript = (Join-Path $PSScriptRoot "restore-fork-rebase-reference.ps1").Replace("'", "''")
  Write-Host "Recovery commands (restore every original branch tip):" -ForegroundColor Yellow
  Write-Host "   git rebase --abort   # only if a rebase is still in progress"
  Write-Host "   git checkout $top"
  Write-Host "   git reset --hard refs/backup/$top-$Stamp"
  foreach ($branch in $Branches) {
    if ($branch -eq $top) { continue }
    Write-Host "   git branch -f $branch refs/backup/$branch-$Stamp"
  }
  Write-Host "   powershell -ExecutionPolicy Bypass -File '$restoreScript'"
  Write-Host "The checked-out top branch uses reset --hard because git branch -f cannot move the current branch."
  Write-Host "The final helper restores the saved local reference bytes/S bit and removes its durable Git-dir state."
  Write-Host "Nothing was pushed."
}

function Fail-AfterRebase([string]$Message, [string]$Stamp, [int]$Code = 1) {
  if ($Code -eq 0) { $Code = 1 }
  Write-Host $Message -ForegroundColor Red
  Write-Recovery $Stamp
  Exit-Script $Code
}

function Stop-OnConflict([string]$What, [string]$Stamp) {
  $continueScript = (Join-Path $PSScriptRoot "continue-fork-rebase.ps1").Replace("'", "''")
  $identityRef = $oldTips[$top]
  Write-Host ""
  Write-Host "Rebase of $What stopped (conflict or error)." -ForegroundColor Yellow
  Write-Host "1. Resolve the conflicted files (git status lists them)."
  Write-Host "2. Stage them: git add <files>"
  Write-Host "3. Continue with the preserved replay identity (repeat until it finishes):"
  Write-Host "   powershell -ExecutionPolicy Bypass -File '$continueScript' -IdentityRef $identityRef"
  Write-Host "   Or give up and run the recovery commands below."
  Write-Host "Backups of the original tips:"
  foreach ($branch in $Branches) {
    Write-Host "   refs/backup/$branch-$Stamp"
  }
  Write-Recovery $Stamp
  Write-Host "When the rebase is done, run the checks by hand:"
  Write-Host "   bun --cwd packages/app typecheck; bun --cwd packages/opencode typecheck; bun --cwd packages/desktop build"
  Exit-Script 1
}

$pluginRoot = Split-Path $PSScriptRoot -Parent
$forkRoot = Join-Path (Split-Path $pluginRoot -Parent) "opencode"

if (-not (Test-Path (Join-Path $forkRoot ".git"))) {
  Fail "OpenCode fork not found at $forkRoot"
}

Set-Location $forkRoot

if ($Branches.Count -lt 1) { Fail "Pass at least one branch in -Branches." }
$bottom = $Branches[0]
$top = $Branches[$Branches.Count - 1]

$versionText = (git version) -replace '^git version\s+', ''
if ($LASTEXITCODE -ne 0) { Fail "git is not available." }
$versionParts = $versionText.Split(".")
$major = [int]($versionParts[0] -replace '\D.*$', '')
$minor = [int]($versionParts[1] -replace '\D.*$', '')
if ($major -lt 2 -or ($major -eq 2 -and $minor -lt 38)) {
  Fail "git 2.38 or newer is required because this script rebases the full stack atomically with --update-refs."
}

foreach ($marker in @("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD")) {
  $markerPath = git rev-parse --git-path $marker
  if ($LASTEXITCODE -ne 0) { Fail "git rev-parse failed in $forkRoot" $LASTEXITCODE }
  if (Test-Path $markerPath) {
    Fail "A git operation is already in progress ($marker). Finish it (git rebase --continue) or abort it (git rebase --abort / git merge --abort), then re-run."
  }
}
if (Test-RebaseReferenceState) {
  Fail "A durable skip-worktree reference backup already exists. Continue/abort the earlier rebase, then run scripts/restore-fork-rebase-reference.ps1 before starting another."
}

$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0) { Fail "git status failed in $forkRoot" $LASTEXITCODE }
if ($dirty) {
  Write-Host "Refuse to rebase: working tree is dirty."
  Write-Host ($dirty -join "`n")
  Write-Host "Commit or stash your changes, then re-run this script."
  Exit-Script 1
}

$skipped = @(git ls-files -v | Where-Object { $_ -cmatch '^S ' } | ForEach-Object { $_.Substring(2) })
if ($skipped.Count -gt 0) {
  Write-Host "Note: these paths are marked skip-worktree and keep their local content during the rebase:"
  foreach ($path in $skipped) { Write-Host "   $path" }
}

$referenceRelative = "packages/app/src/custom-elements.d.ts"
$referenceWasSkipped = $skipped -ccontains $referenceRelative
$script:rebaseStamp = $null
if ($referenceWasSkipped) {
  try {
    Get-RebaseReferenceIndexEntry -RelativePath $referenceRelative | Out-Null
  } catch {
    Fail $_
  }
  Write-Host "Will durably preserve the local skip-worktree reference file: $referenceRelative"
}

$oldTips = [ordered]@{}
foreach ($branch in $Branches) {
  $sha = git rev-parse --verify --quiet "refs/heads/$branch"
  if ($LASTEXITCODE -ne 0 -or -not $sha) { Fail "Branch $branch not found." }
  $oldTips[$branch] = $sha
}
for ($i = 1; $i -lt $Branches.Count; $i++) {
  $lower = $Branches[$i - 1]
  $upper = $Branches[$i]
  git merge-base --is-ancestor $oldTips[$lower] $oldTips[$upper]
  if ($LASTEXITCODE -ne 0) { Fail "$lower is not an ancestor of $upper; -Branches must be a stack, bottom first." }
}
try {
  $replayIdentity = Get-RebaseCommitterIdentity -Ref $oldTips[$top]
} catch {
  Fail "Could not reuse the pre-rebase top commit's committer identity: $_"
}

Write-Host "Fetching upstream tag $Tag"
git fetch --no-tags upstream "refs/tags/${Tag}:refs/tags/${Tag}"
if ($LASTEXITCODE -ne 0) {
  Fail "Failed to fetch tag $Tag from upstream. Check that the upstream remote exists and the tag is published." $LASTEXITCODE
}
$newBase = git rev-parse --verify --quiet "refs/tags/${Tag}^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $newBase) { Fail "Tag $Tag does not point to a commit." }

if (-not $OldBase) {
  Write-Host "Fetching upstream $UpstreamBranch to locate the current base of $bottom"
  git fetch --no-tags upstream "refs/heads/${UpstreamBranch}:refs/remotes/upstream/${UpstreamBranch}"
  if ($LASTEXITCODE -ne 0) { Fail "Failed to fetch upstream $UpstreamBranch. Pass -OldBase <commit> instead." $LASTEXITCODE }
  $OldBase = git merge-base $oldTips[$bottom] "refs/remotes/upstream/$UpstreamBranch"
  if ($LASTEXITCODE -ne 0 -or -not $OldBase) {
    Fail "Could not find where $bottom leaves upstream/$UpstreamBranch. Pass -OldBase <commit>."
  }
}
$oldBaseSha = git rev-parse --verify --quiet "$OldBase^{commit}"
if ($LASTEXITCODE -ne 0 -or -not $oldBaseSha) { Fail "-OldBase $OldBase is not a commit." }
git merge-base --is-ancestor $oldBaseSha $oldTips[$bottom]
if ($LASTEXITCODE -ne 0) { Fail "Old base $oldBaseSha is not an ancestor of $bottom." }

$replay = @(git rev-list "$oldBaseSha..$($oldTips[$top])")
if ($replay.Count -eq 0) { Fail "Nothing to replay between $oldBaseSha and $top." }
Write-Host "Current base: $oldBaseSha"
Write-Host "New base:     $Tag ($newBase)"
Write-Host "Commits to replay ($($replay.Count)):"
git --no-pager log --oneline --reverse "$oldBaseSha..$($oldTips[$top])"
if ($replay.Count -gt $MaxCommits) {
  Fail "Refusing to replay $($replay.Count) commits (more than -MaxCommits $MaxCommits); the base is probably wrong. Pass -OldBase <commit>."
}
if ($oldBaseSha -eq $newBase) {
  Write-Host "Branches already sit on $Tag; nothing to do. Nothing was pushed."
  Exit-Script 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$script:rebaseStamp = $stamp
foreach ($branch in $Branches) {
  $backup = "refs/backup/$branch-$stamp"
  git update-ref $backup $oldTips[$branch]
  if ($LASTEXITCODE -ne 0) { Fail "Failed to create backup ref $backup" $LASTEXITCODE }
  Write-Host "Backup: $backup -> $($oldTips[$branch])"
}

if ($referenceWasSkipped) {
  try {
    $script:referencePrepared = [bool](Prepare-RebaseReference -RelativePath $referenceRelative)
  } catch {
    $prepareError = $_
    try {
      $script:referencePrepared = [bool](Test-RebaseReferenceState)
    } catch {
      # If state inspection itself fails, attempt the durable restore path rather than
      # risking a published backup with skip-worktree already cleared.
      $script:referencePrepared = $true
    }
    Fail-AfterRebase "Failed to prepare the skip-worktree reference for rebase: $prepareError" $stamp
  }
}

Write-Host "Checking out $top"
git checkout $top
if ($LASTEXITCODE -ne 0) { Fail-AfterRebase "Failed to check out $top" $stamp $LASTEXITCODE }

Write-Host "Rebasing $($Branches -join ', ') onto $Tag in one pass (--update-refs)"
Invoke-GitWithRebaseIdentity `
  -Identity $replayIdentity `
  -Arguments @("rebase", "--update-refs", "--onto", $newBase, $oldBaseSha) `
  -NonInteractive
$rebaseCode = $LASTEXITCODE
try {
  $script:rebaseStarted = [bool](Test-GitRebaseInProgress)
} catch {
  $script:rebaseStarted = $true
  Stop-OnConflict "$($Branches -join ', ') (rebase state could not be inspected)" $stamp
}
if ($rebaseCode -ne 0) {
  if ($script:rebaseStarted) {
    Stop-OnConflict ($Branches -join ", ") $stamp
  }
  Fail-AfterRebase "Rebase command failed before creating rebase state." $stamp $rebaseCode
}
if ($script:rebaseStarted) {
  Stop-OnConflict "$($Branches -join ', ') (Git returned success but rebase state remains)" $stamp
}

if ($script:referencePrepared) {
  try {
    Restore-RebaseReference | Out-Null
    $script:referencePrepared = $false
  } catch {
    Write-Host "Rebase finished, but the local skip-worktree reference could not be restored: $_" -ForegroundColor Red
    Write-Recovery $stamp
    exit 1
  }
}

$previous = $newBase
foreach ($branch in $Branches) {
  $tip = git rev-parse "refs/heads/$branch"
  if ($LASTEXITCODE -ne 0 -or -not $tip) {
    Fail-AfterRebase "Could not read the rebased tip of $branch." $stamp $LASTEXITCODE
  }
  git merge-base --is-ancestor $previous $tip
  if ($LASTEXITCODE -ne 0) { Fail-AfterRebase "$branch was not moved onto $Tag correctly." $stamp $LASTEXITCODE }
  Write-Host "$branch -> $tip"
  $previous = $tip
}

Write-Host "Typechecking packages/app"
bun --cwd packages/app typecheck
if ($LASTEXITCODE -ne 0) { Fail-AfterRebase "packages/app typecheck failed" $stamp $LASTEXITCODE }

Write-Host "Typechecking packages/opencode"
bun --cwd packages/opencode typecheck
if ($LASTEXITCODE -ne 0) { Fail-AfterRebase "packages/opencode typecheck failed" $stamp $LASTEXITCODE }

Write-Host "Building packages/desktop"
bun --cwd packages/desktop build
if ($LASTEXITCODE -ne 0) { Fail-AfterRebase "packages/desktop build failed" $stamp $LASTEXITCODE }

Write-Host "Rebase onto $Tag completed. Current branch: $(git branch --show-current). Nothing was pushed."
