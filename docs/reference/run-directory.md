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
  - `role` is `planner` (the planning session, its format retries and its answers resume), `planner_chat` (a chat turn
    with the planner, see below), `worker` (a task attempt, or the solo session), or `repair` (an integration repair
    attempt). A replan session is a `planner` line with the task's `task_id` and `generation`, and `attempt` null.
  - `task_id`, `generation` and `attempt` are null where they do not apply (the planner, a repair attempt has no task id).
- Each following line is `{"ts": "<ISO time>", "event": <BackendEvent>}`. The event is what the adapter streamed:
  `session.started`, `assistant.text`, `tool.call`, `tool.result`, `permission.denied`, `usage`, `subagent`, `error`
  or `session.result`.
- A text field longer than 8192 characters is cut, and the cut ends with `[truncated: N more characters]`.
- A session that resumes (a format retry, an answers resume, a chat turn that resumes the planning session) appends to
  its file; the header is written once, so a chat turn that resumes the planning session keeps the `planner` role.
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

## Inbox, chat and amendments

`inbox/<n>.json`: one message for the engine, numbered from 1 across `inbox/` and `inbox/consumed/`. The server writes a
`chat` message for each chat message a person sends (`{"v":1,"n","ts","kind":"chat","chat_id","text"}`). The planner's
chat turn writes an `amendment` message when the planner wrote a checked amendment (`{"v":1,"n","ts","kind":"amendment",
"chat_id","dir":"amendments/<chat_id>"}`). Each file is written under a temporary name and linked into place, so the engine
never reads a half-written message and no number is written twice.

- The engine reads the pending messages oldest first. A message it has processed is moved to `inbox/consumed/` (a name already
  there gets a numbered suffix). Nothing is deleted. A file that does not validate is moved there too and refused in chat.
- `amendments/<chat_id>/`: a full plan (`manifest.yaml`, `tasks/<ID>.md`, the contract stubs at their repo-relative paths).
  The planner's chat turn runs the plan lint on it (blockers only) before it queues it, and the engine runs the lint again
  when it applies it. It is then diffed against the run's tasks by id. A task that has started (running, passed, merged,
  failed) is never changed: it is reported as kept. A pending task may be changed or dropped, and a new task may be added
  with dependencies on any task. A contract change is typechecked and committed on the run branch, as a replan does.
- A live run applies an amendment between actions. A stopped, paused or failed run applies it when it is resumed. A finished
  or cancelled run does not: the chat turn does not queue an amendment for it, and the engine refuses one. A refused
  amendment changes nothing.

`chat.jsonl`: one JSON message per line (`{"id":"c<n>","ts","role","text","status","reply_to","session_id","amendment"}`).
The last line for an id wins. `role` is `user` (the person), `planner` (the planner's reply, with `reply_to` set to the
message it answers and `session_id` the planner session) or `system` (a note: what an amendment did, or why nothing was
changed). The engine writes a system reply for each amendment it applied or refused, with `reply_to` set to the
amendment's chat id and `amendment` set to what changed (`added`, `changed`, `dropped`, `kept_started`, and `reason` when
refused). The ids are allocated under `chat.lock`, a short-lived lock file that is removed when the write ends.

Files of a chat turn, next to `chat.jsonl`:

- `chat-turn.lock`: the one chat turn that answers the run's messages, with its `pid`. A lock whose process is gone is taken
  over. A turn that finds the lock held exits, and the holder answers what arrived meanwhile.
- `chat-turn.log`: the output of the detached turn process (what it printed, including any crash).

Two engine events record the inbox and the amendments (`events.jsonl`):

- `run.message`: an inbox message was accepted. `{message_id, kind, chat_id}`. It changes no task state.
- `run.amended`: an amendment was applied or refused. `{chat_id, outcome, applied_at, added, changed, dropped, kept_started,
  warning_count, reason?, tasks?}`. `applied_at` is `live` or `resume`. An applied amendment adds its new tasks as pending,
  changes its changed tasks back to pending, and abandons its dropped tasks. Their dependents are skipped, as after any failed
  dependency. A dropped task stays dropped when the run is reopened.

Usage of a chat turn is recorded with role `planner_chat`: one ledger line in `.substrate/ledger/usage.jsonl` (and the global
mirror) per turn, and, while the run is not live, one `usage.recorded` event with `role: "planner_chat"` in `events.jsonl`, so
the job's totals count it. A live run's journal is written only by its engine, so a chat turn on a live run adds its cost to
the ledger only.
