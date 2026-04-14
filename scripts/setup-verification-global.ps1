$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repoRoot ".cursor/global"
$targetRoot = Join-Path $HOME ".cursor"

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $targetRoot "rules") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $targetRoot "skills/verification-reviewer") | Out-Null

Copy-Item -Force (Join-Path $sourceRoot "hooks.json") (Join-Path $targetRoot "hooks.json")
Copy-Item -Force (Join-Path $sourceRoot "rules/verification-reviewer.mdc") (Join-Path $targetRoot "rules/verification-reviewer.mdc")
Copy-Item -Force (Join-Path $repoRoot ".cursor/skills/verification-reviewer/SKILL.md") (Join-Path $targetRoot "skills/verification-reviewer/SKILL.md")

Write-Host "[ok] Global verification setup installed at $targetRoot"
