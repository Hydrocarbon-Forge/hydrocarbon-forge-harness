---
id: T04-mechanical-lint
title: "Format code and fix ESLint stylistic warnings"
task_class: mechanical
tags:
  - lint
  - formatting
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup mechanical lint'"
    timeout_s: 15
verify:
  - run: "npm run lint"
    timeout_s: 15
budget:
  max_usd: 0.50
  timeout_min: 3
---

## Description
Apply automated linter fixes and normalize indentation across codebase.
