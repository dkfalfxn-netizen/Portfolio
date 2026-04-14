# Verification System Setup (Portable)

This repository includes a portable verification setup so the same validation behavior can be reused on any machine.

## What gets installed globally

- `~/.cursor/hooks.json`
- `~/.cursor/rules/verification-reviewer.mdc`
- `~/.cursor/skills/verification-reviewer/SKILL.md`

These make the validation workflow available across all projects.

## Install on Windows (PowerShell)

From repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-verification-global.ps1
```

## Install on macOS/Linux

From repository root:

```bash
bash ./scripts/setup-verification-global.sh
```

## Project-specific rule

This repo also has a project override:

- `.cursor/rules/verification-reviewer.mdc`

So even without global install, this project keeps stricter verification guidance.

## Notes

- Re-run setup script after updating verification templates in this repo.
- If Cursor is open and behavior does not refresh immediately, restart Cursor once.
