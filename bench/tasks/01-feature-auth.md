---
id: T01-feature-auth
title: "Implement token authentication middleware"
task_class: feature
tags:
  - auth
  - middleware
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup token auth middleware environment'"
    timeout_s: 30
verify:
  - run: "npm test"
    timeout_s: 30
budget:
  max_usd: 1.50
  timeout_min: 10
---

## Description
Implement JWT token authentication middleware verifying signatures and expiration.
