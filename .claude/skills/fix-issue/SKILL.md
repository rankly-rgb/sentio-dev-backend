---
name: fix-issue
description: Fix a GitHub issue end-to-end
disable-model-invocation: true
---

Fix GitHub issue: $ARGUMENTS

## Workflow

1. **Read issue**: `gh issue view $ARGUMENTS`
2. **Explore**: Read all relevant files mentioned in the issue
3. **Plan**: Propose a fix plan (3-7 steps), wait for user approval
4. **Branch**: `git checkout -b fix/issue-$ARGUMENTS`
5. **Implement**: Write the fix, following existing patterns
6. **Test**: Write/update tests if needed, then `npm run verify`
7. **Commit**: Conventional commit message referencing the issue (`fix: ... (#$ARGUMENTS)`)
8. **PR**: `gh pr create` with summary and test plan
