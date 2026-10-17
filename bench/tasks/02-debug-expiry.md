---
id: T02-debug-expiry
title: "Fix clock drift token expiry validation bug"
task_class: debug
tags:
  - auth
  - bugfix
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup debug environment'"
    timeout_s: 30
verify:
  - run: "npm test"
    timeout_s: 30
budget:
  max_usd: 1.00
  timeout_min: 5
---

## Description
Resolve clock skew issues causing valid tokens to prematurely fail expiry validation.
