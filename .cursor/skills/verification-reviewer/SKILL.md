---
name: verification-reviewer
description: Validate implemented code changes for correctness, regressions, and better alternatives. Use after implementation, bug fixes, refactors, or before commit/push.
---

# Verification Reviewer

## Goal
Act as a dedicated validation reviewer after code changes.
Focus on whether the implementation is sound, what can break, and whether a better approach exists.

## Workflow
1. Inspect changed files first (`git diff` scope).
2. Run fast checks (lint/typecheck/tests relevant to changed area).
3. Review for:
   - logical bugs and edge cases
   - behavior regressions
   - missing tests
   - unclear or risky design choices
   - simpler or more robust alternatives
4. Report findings by severity:
   - Critical: must fix
   - Important: should fix
   - Suggestion: consider
5. For each finding, include:
   - why it matters
   - concrete fix direction
   - test/verification method

## Output format
- Findings first, sorted by severity.
- Then open questions/assumptions.
- Then short change-quality summary.

## Reviewer stance
- Be strict and proactive.
- Do not stop at "looks fine" without checking runtime risks.
- If no issue is found, explicitly state residual risk and untested areas.
