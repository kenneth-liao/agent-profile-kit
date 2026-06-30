---
name: dispatch-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Dispatch Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history. This keeps the reviewer focused on the work product, not your thought process, and preserves your own context for continued work.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After completing a major feature or a discrete unit of work
- Before opening a PR / merging to `main`
- After resolving an issue (see `/resolve-issue`) before marking it done

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

> This skill dispatches a subagent for a deep, plan-aware review. For a fast,
> diff-focused pass on the working tree, the built-in `/code-review` skill is
> often the quicker tool — reach for this skill when you want review against a
> plan/requirements with isolated context.

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch code reviewer subagent:**

Use the Agent tool with `subagent_type: general-purpose`, filling the template at `code-reviewer.md`. The reviewer inherits the current session's model by default; pass the Agent tool's `model` field (e.g. `opus`) only if you want to pin a specific one.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just finished hardening the license-binding comparison sites]

You: Let me request code review before opening the PR.

BASE_SHA=$(git rev-parse origin/main)
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code reviewer subagent via Agent tool]
  DESCRIPTION: Added string coercion to license-binding comparison sites
  PLAN_OR_REQUIREMENTS: issues/prd2-license-binding (#3)
  BASE_SHA: <origin/main sha>
  HEAD_SHA: <branch HEAD sha>

[Subagent returns]:
  Strengths: Defensive coercion is consistent, real tests added
  Issues:
    Important: One comparison site still compares raw values
    Minor: Duplicated coercion helper could be extracted
  Assessment: With fixes

You: [Fix the remaining comparison site, then open the PR]
```

## Integration with Workflows

**Issue / PRD work (`/resolve-issue`, `/tdd`):**
- Review after resolving each issue, before marking it done
- Catch issues before they compound across a multi-issue PRD

**Branch / PR work:**
- Review before opening a PR or merging to `main`
- Use `BASE_SHA=$(git rev-parse origin/main)` for the full branch diff

**Ad-Hoc Development:**
- Review when stuck for a fresh perspective

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: dispatch-code-review/code-reviewer.md
