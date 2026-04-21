Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourcePath = Join-Path $HOME ".codex\auth.json"
$targetDirectory = Join-Path $repoRoot "data\secrets"
$targetPath = Join-Path $targetDirectory "openai_codex_auth.json"

if (-not (Test-Path $sourcePath)) {
    throw "Codex auth file was not found at '$sourcePath'. Sign in with the Codex app or Codex CLI first."
}

$json = Get-Content -Raw -Path $sourcePath | ConvertFrom-Json
if ($null -eq $json.tokens -or [string]::IsNullOrWhiteSpace($json.tokens.access_token) -or [string]::IsNullOrWhiteSpace($json.tokens.refresh_token)) {
    throw "The Codex auth file does not contain the expected ChatGPT OAuth tokens."
}

New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
Copy-Item -Path $sourcePath -Destination $targetPath -Force

Write-Host "Copied Codex OAuth credentials to $targetPath"
Write-Host "Start or restart the categorizer with: docker compose up -d --build"
