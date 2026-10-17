---
id: T05-boilerplate-license
title: "Add Apache 2.0 license headers to all source files"
task_class: boilerplate
tags:
  - license
  - boilerplate
repo_fixture: bench/fixtures/sample-repo
setup:
  - run: "echo 'Setup boilerplate license headers'"
    timeout_s: 15
verify:
  - run: "npm run lint"
    timeout_s: 15
budget:
  max_usd: 0.50
  timeout_min: 3
---

## Description
Add standard license header comments to all source files missing headers.
