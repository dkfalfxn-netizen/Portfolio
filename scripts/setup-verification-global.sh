#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="$repo_root/.cursor/global"
target_root="${HOME}/.cursor"

mkdir -p "$target_root/rules"
mkdir -p "$target_root/skills/verification-reviewer"

cp "$source_root/hooks.json" "$target_root/hooks.json"
cp "$source_root/rules/verification-reviewer.mdc" "$target_root/rules/verification-reviewer.mdc"
cp "$repo_root/.cursor/skills/verification-reviewer/SKILL.md" "$target_root/skills/verification-reviewer/SKILL.md"

echo "[ok] Global verification setup installed at $target_root"
