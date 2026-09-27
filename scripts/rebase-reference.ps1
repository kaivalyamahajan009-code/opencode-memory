$script:RebaseReferenceStateName = "opencode-memory-rebase-reference"

function Get-RebaseGitDirectory {
  $gitDirectory = @(git rev-parse --path-format=absolute --git-dir)
  if ($LASTEXITCODE -ne 0 -or $gitDirectory.Count -ne 1) {
    throw "Could not resolve the repository Git directory."
  }
  [System.IO.Path]::GetFullPath([string]$gitDirectory[0])
}

function Get-RebaseWorkTree {
  $workTree = @(git rev-parse --path-format=absolute --show-toplevel)
  if ($LASTEXITCODE -ne 0 -or $workTree.Count -ne 1) {
    throw "Could not resolve the repository worktree."
  }
  [System.IO.Path]::GetFullPath([string]$workTree[0])
}

function Get-RebaseReferenceStateDirectories {
  $gitDirectory = Get-RebaseGitDirectory
  $result = @()
  $published = Join-Path $gitDirectory $script:RebaseReferenceStateName
  if (Test-Path -LiteralPath $published) {
    $result += $published
  }
  $temporary = @(
    Get-ChildItem -Force -Directory -LiteralPath $gitDirectory |
      Where-Object { $_.Name.StartsWith("$($script:RebaseReferenceStateName).tmp-", [System.StringComparison]::Ordinal) } |
      ForEach-Object { $_.FullName }
  )
  $result + $temporary
}

function Test-RebaseReferenceState {
  @(Get-RebaseReferenceStateDirectories).Count -gt 0
}

function Test-GitRebaseInProgress {
  foreach ($marker in @("rebase-merge", "rebase-apply")) {
    $path = @(git rev-parse --git-path $marker)
    if ($LASTEXITCODE -ne 0 -or $path.Count -ne 1) {
      throw "Could not inspect the current rebase state."
    }
    if (Test-Path -LiteralPath ([string]$path[0])) {
      return $true
    }
  }
  $false
}

function Get-RebaseReferenceIndexEntry {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $entry = @(git ls-files --stage -- $RelativePath)
  if ($LASTEXITCODE -ne 0 -or $entry.Count -ne 1) {
    throw "$RelativePath must have exactly one tracked index entry."
  }
  $match = [regex]::Match([string]$entry[0], "^([0-9]{6}) ([0-9a-f]+) ([0-3])`t(.+)$")
  if (-not $match.Success -or $match.Groups[3].Value -ne "0") {
    throw "$RelativePath must have one stage-zero index entry."
  }
  if ($match.Groups[1].Value -ne "120000") {
    throw "$RelativePath must remain a committed mode-120000 symlink."
  }
  [pscustomobject]@{
    Mode = $match.Groups[1].Value
    Blob = $match.Groups[2].Value
  }
}

function Test-RebaseReferenceSkipped {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $entry = @(git ls-files -v -- $RelativePath)
  if ($LASTEXITCODE -ne 0 -or $entry.Count -ne 1) {
    throw "Could not inspect the skip-worktree state for $RelativePath."
  }
  ([string]$entry[0]).StartsWith("S ", [System.StringComparison]::Ordinal)
}

function Get-RebaseReferenceHash {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    (($algorithm.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $algorithm.Dispose()
  }
}

function Read-RebaseGitBlob {
  param([Parameter(Mandatory = $true)][string]$Blob)

  if ($Blob -notmatch "^[0-9a-f]+$") {
    throw "The index blob id is invalid."
  }
  $gitCommand = Get-Command git -ErrorAction Stop
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $gitCommand.Source
  $start.Arguments = "cat-file blob $Blob"
  $start.WorkingDirectory = Get-RebaseWorkTree
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  $memory = New-Object System.IO.MemoryStream
  try {
    if (-not $process.Start()) {
      throw "Could not start git cat-file."
    }
    $process.StandardOutput.BaseStream.CopyTo($memory)
    $errorText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "Could not read the index blob (git exit $($process.ExitCode)): $errorText"
    }
    $memory.ToArray()
  } finally {
    $memory.Dispose()
    $process.Dispose()
  }
}

function Read-RebaseReferenceState {
  $directories = @(Get-RebaseReferenceStateDirectories)
  if ($directories.Count -eq 0) {
    return $null
  }
  if ($directories.Count -ne 1) {
    throw "Multiple durable reference states exist; refusing to guess which backup to use."
  }
  $directory = [string]$directories[0]
  $statePath = Join-Path $directory "state.json"
  $backupPath = Join-Path $directory "replacement.bin"
  if (-not (Test-Path -LiteralPath $statePath) -or -not (Test-Path -LiteralPath $backupPath)) {
    throw "The durable reference state is incomplete; its files were left untouched."
  }
  try {
    $state = [System.IO.File]::ReadAllText($statePath) | ConvertFrom-Json
  } catch {
    throw "The durable reference state metadata is invalid; its files were left untouched."
  }
  if ($state.Version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$state.RelativePath)) {
    throw "The durable reference state metadata is unsupported; its files were left untouched."
  }
  $bytes = [System.IO.File]::ReadAllBytes($backupPath)
  if (
    [long]$state.Length -ne $bytes.LongLength -or
    [string]$state.Sha256 -cne (Get-RebaseReferenceHash -Bytes $bytes)
  ) {
    throw "The durable reference backup failed its length/hash check; it was left untouched."
  }
  [pscustomobject]@{
    Directory = $directory
    State = $state
    Bytes = $bytes
  }
}

function Prepare-RebaseReference {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  if (Test-RebaseReferenceState) {
    throw "A durable reference backup already exists; restore it before starting another rebase."
  }
  $entry = Get-RebaseReferenceIndexEntry -RelativePath $RelativePath
  if (-not (Test-RebaseReferenceSkipped -RelativePath $RelativePath)) {
    return $false
  }

  $workTree = Get-RebaseWorkTree
  $workPath = [System.IO.Path]::GetFullPath((Join-Path $workTree $RelativePath))
  $workRoot = $workTree.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  if (-not $workPath.StartsWith($workRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The reference path escapes the repository worktree."
  }
  if (-not (Test-Path -LiteralPath $workPath)) {
    throw "The skip-worktree reference replacement is missing: $RelativePath"
  }
  $item = Get-Item -Force -LiteralPath $workPath
  if ($item.PSIsContainer -or [bool]$item.LinkType) {
    throw "The skip-worktree reference must be a regular local replacement."
  }

  $replacement = [System.IO.File]::ReadAllBytes($workPath)
  $indexBytes = Read-RebaseGitBlob -Blob $entry.Blob
  $gitDirectory = Get-RebaseGitDirectory
  $published = Join-Path $gitDirectory $script:RebaseReferenceStateName
  $temporary = "$published.tmp-$([guid]::NewGuid().ToString('N'))"
  $publishedState = $false
  try {
    [System.IO.Directory]::CreateDirectory($temporary) | Out-Null
    $backupPath = Join-Path $temporary "replacement.bin"
    $statePath = Join-Path $temporary "state.json"
    [System.IO.File]::WriteAllBytes($backupPath, $replacement)
    $state = [ordered]@{
      Version = 1
      RelativePath = $RelativePath
      IndexMode = $entry.Mode
      PreparedBlob = $entry.Blob
      Length = $replacement.LongLength
      Sha256 = Get-RebaseReferenceHash -Bytes $replacement
    }
    $json = $state | ConvertTo-Json -Compress
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($statePath, $json, $encoding)

    $verified = [System.IO.File]::ReadAllBytes($backupPath)
    if (
      $verified.LongLength -ne $replacement.LongLength -or
      (Get-RebaseReferenceHash -Bytes $verified) -cne $state.Sha256
    ) {
      throw "The durable reference backup could not be verified."
    }
    [System.IO.Directory]::Move($temporary, $published)
    $publishedState = $true

    git update-index --no-skip-worktree -- $RelativePath
    if ($LASTEXITCODE -ne 0) {
      throw "Could not clear skip-worktree for $RelativePath."
    }
    [System.IO.File]::WriteAllBytes($workPath, $indexBytes)
    $prepared = [System.IO.File]::ReadAllBytes($workPath)
    if (
      [System.Convert]::ToBase64String($prepared) -cne
      [System.Convert]::ToBase64String($indexBytes)
    ) {
      throw "Could not materialize the exact index symlink payload for $RelativePath."
    }
    if (Test-RebaseReferenceSkipped -RelativePath $RelativePath) {
      throw "skip-worktree remained set for $RelativePath."
    }
    $true
  } catch {
    if (-not $publishedState -and (Test-Path -LiteralPath $temporary)) {
      Remove-Item -Recurse -Force -LiteralPath $temporary
    }
    throw
  }
}

function Assert-RebaseReferencePrepared {
  $saved = Read-RebaseReferenceState
  if ($null -eq $saved) {
    return $false
  }
  $relativePath = [string]$saved.State.RelativePath
  Get-RebaseReferenceIndexEntry -RelativePath $relativePath | Out-Null
  if (Test-RebaseReferenceSkipped -RelativePath $relativePath) {
    throw "The durable reference exists, but skip-worktree was restored before the rebase finished."
  }
  $true
}

function Restore-RebaseReference {
  $saved = Read-RebaseReferenceState
  if ($null -eq $saved) {
    return $false
  }
  if (Test-GitRebaseInProgress) {
    throw "A rebase is still in progress; continue it or abort it before restoring the local reference."
  }

  $relativePath = [string]$saved.State.RelativePath
  $entry = Get-RebaseReferenceIndexEntry -RelativePath $relativePath
  if ($entry.Mode -ne [string]$saved.State.IndexMode) {
    throw "The reference index mode changed; the durable backup was left untouched."
  }
  $workTree = Get-RebaseWorkTree
  $workPath = [System.IO.Path]::GetFullPath((Join-Path $workTree $relativePath))
  $workRoot = $workTree.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  if (-not $workPath.StartsWith($workRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The saved reference path escapes the repository worktree."
  }
  if (Test-Path -LiteralPath $workPath) {
    $item = Get-Item -Force -LiteralPath $workPath
    if ($item.PSIsContainer -or [bool]$item.LinkType) {
      throw "Refusing to overwrite a non-regular reference path; the durable backup was left untouched."
    }
  }

  [System.IO.File]::WriteAllBytes($workPath, [byte[]]$saved.Bytes)
  $restored = [System.IO.File]::ReadAllBytes($workPath)
  if (
    $restored.LongLength -ne [long]$saved.State.Length -or
    (Get-RebaseReferenceHash -Bytes $restored) -cne [string]$saved.State.Sha256
  ) {
    throw "The restored reference bytes failed verification; the durable backup was left untouched."
  }
  git update-index --skip-worktree -- $relativePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-RebaseReferenceSkipped -RelativePath $relativePath)) {
    throw "Could not restore skip-worktree; the durable backup was left untouched."
  }
  $restored = [System.IO.File]::ReadAllBytes($workPath)
  if (
    $restored.LongLength -ne [long]$saved.State.Length -or
    (Get-RebaseReferenceHash -Bytes $restored) -cne [string]$saved.State.Sha256
  ) {
    throw "The reference bytes changed after restoring skip-worktree; the durable backup was left untouched."
  }

  Remove-Item -Recurse -Force -LiteralPath $saved.Directory
  if (Test-Path -LiteralPath $saved.Directory) {
    throw "The reference was restored, but the durable state could not be removed."
  }
  $true
}
