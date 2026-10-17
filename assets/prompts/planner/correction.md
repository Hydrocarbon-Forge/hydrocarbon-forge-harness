Your plan failed the engine's deterministic checks (attempt {{attempt}} of {{max_attempts}}). Fix only what is listed; change nothing else and keep every task id stable.

## Problems
{{diagnostics}}

## How to answer
- Rewrite only the files that need to change, each in full (not as a diff), in the same locations as before.
- Do not weaken verification, widen scopes, or drop tasks to make a check pass; correct the real defect.
- Run your own pre-flight checklist again, then finish with `PLAN READY`. If a problem cannot be fixed without information you do not have, write `QUESTIONS.md` and finish with `NEEDS INPUT`.
