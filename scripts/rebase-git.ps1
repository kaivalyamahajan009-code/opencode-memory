function Get-RebaseCommitterIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Ref
  )

  $spec = "${Ref}^{commit}"
  $commit = @(git rev-parse --verify --quiet --end-of-options $spec)
  if ($LASTEXITCODE -ne 0 -or $commit.Count -ne 1) {
    throw "The replay identity ref is not a commit: $Ref"
  }
  $name = @(git show -s --format=%cn $commit[0] --)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the replay committer name from $Ref."
  }
  $email = @(git show -s --format=%ce $commit[0] --)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read the replay committer email from $Ref."
  }
  if ($name.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$name[0])) {
    throw "The replay committer name from $Ref is empty or invalid."
  }
  if ($email.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$email[0])) {
    throw "The replay committer email from $Ref is empty or invalid."
  }

  [pscustomobject]@{
    Name = [string]$name[0]
    Email = [string]$email[0]
  }
}

function Invoke-GitWithRebaseIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Identity,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$NonInteractive
  )

  if (
    [string]::IsNullOrWhiteSpace([string]$Identity.Name) -or
    [string]::IsNullOrWhiteSpace([string]$Identity.Email)
  ) {
    throw "A nonempty replay committer name and email are required."
  }

  $config = @(
    "-c",
    "user.name=$($Identity.Name)",
    "-c",
    "user.email=$($Identity.Email)"
  )
  if ($NonInteractive) {
    $config += @("-c", "core.editor=true")
  }

  $environmentKeys = @(
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
    "GIT_EDITOR"
  )
  $savedEnvironment = @{}
  foreach ($key in $environmentKeys) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
  }
  try {
    $env:GIT_AUTHOR_NAME = $null
    $env:GIT_AUTHOR_EMAIL = $null
    $env:GIT_AUTHOR_DATE = $null
    $env:GIT_COMMITTER_NAME = [string]$Identity.Name
    $env:GIT_COMMITTER_EMAIL = [string]$Identity.Email
    $env:GIT_COMMITTER_DATE = $null
    if ($NonInteractive) {
      $env:GIT_EDITOR = "true"
    }
    & git @config @Arguments
  } finally {
    foreach ($key in $environmentKeys) {
      [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], "Process")
    }
  }
}
