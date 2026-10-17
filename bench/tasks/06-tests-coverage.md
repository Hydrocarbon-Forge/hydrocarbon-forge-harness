---
id: T06-tests-coverage
title: "Add unit tests for error handling paths"
task_class: tests
tags:
  - tests
  - coverage
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup tests suite'"
    timeout_s: 30
verify:
  - run: "npm test"
    timeout_s: 30
budget:
  max_usd: 1.00
  timeout_min: 5
---

## Description
Add unit test coverage for edge case error handling in router and middleware.
