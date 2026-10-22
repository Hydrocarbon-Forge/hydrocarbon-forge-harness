# The run directory

Every run writes its record under `.substrate/runs/<run_id>/` in the project. The event log, the plan files and the
worker reports are the record of the run; `substrate status`, `report` and the web UI read them from disk, so a
finished run stays inspectable after the process has gone.

This page lists the files the web UI reads (see `docs/design/web-ui.md`, section 6). Everything here is written by
the engine and the roles as the run goes; nothing is rewritten after a session ends, except that a session's
transcript grows while the session runs.

## Transcripts

`transcripts/<session>.jsonl`: one file per harness session. `<session>` is the harness session id, with any
character outside `A-Z a-z 0-9 _ . -` replaced by `_`.

- Line 0 is a header: `{"type":"header","v":1,"session","role","task_id","generation","attempt","backend","model","started_at"}`.
  - `role` is `planner` (the planning session, its format retries and its answers resume), `worker` (a task attempt,
    or the solo session), or `repair` (an integration repair attempt). A replan session is a `planner` line with the
    task's `task_id` and `generation`, and `attempt` null.
  - `task_id`, `generation` and `attempt` are null where they do not apply (the planner, a repair attempt has no task id).
- Each following line is `{"ts": "<ISO time>", "event": <BackendEvent>}`. The event is what the adapter streamed:
  `session.started`, `assistant.text`, `tool.call`, `tool.result`, `permission.denied`, `usage`, `subagent`, `error`
  or `session.result`.
- A text field longer than 8192 characters is cut, and the cut ends with `[truncated: N more characters]`.
- A session that resumes (a format retry, an answers resume) appends to its file; the header is written once.
- A session that never reported its id (the harness did not start) has no transcript.

## Verify output

`packets/verify/<task>-g<n>-attempt<k>-<i>.out` and `.err`: the full stdout and stderr of verify command `i` of a worker
attempt, each cut at 64 KB. The stdout path is recorded in the attempt's report as `full_output_path` on the verify
entry; the stderr file has the same name with `.err`. Reports written before this change have no such field.

## Merged patches

`packets/merged/<task>-g<n>.patch`: the changes a task merged into the run branch, taken as the diff from the
integration HEAD it merged onto. Written when the task merges, before its worktree is removed at the end of the run.

## Failed attempts

`packets/<task>-g<n>-attempt<k>.json` (the worker report of each attempt) and `packets/<task>-g<n>.patch` (the work a
task did not merge, saved when the run ends, before its worktree is removed) are unchanged.

## The planner session

`events.jsonl`: the `plan.produced` event carries `planner_session_id`, the session that wrote the accepted plan.
Its transcript is `transcripts/<planner_session_id>.jsonl`. The field is absent when the plan was a draft reused by
a resume or a plan a person reviewed; `run.paused` (reason `needs_human`) still carries the session id of a planning
session that asked questions.
