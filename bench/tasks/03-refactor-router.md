---
id: T03-refactor-router
title: "Refactor route registration to declarative syntax"
task_class: refactor
tags:
  - refactor
  - routing
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup router refactor'"
    timeout_s: 30
verify:
  - run: "npm test"
    timeout_s: 30
budget:
  max_usd: 1.20
  timeout_min: 8
---

## Description
Refactor imperative route definitions into declarative table structures.
