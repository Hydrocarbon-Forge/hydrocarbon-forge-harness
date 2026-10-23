# Web UI audit (ST3): what it is today, why it fails, what the API gives, how it scales

Factual audit. Every claim cites `file:line` or a measured number. Paths are relative to the repository root. Where something is absent the text says "not found". No layout or look is proposed here.

## Client map

Sizes are line counts from `wc -l`. "Keep", "rework" or "drop" is the recommendation for a redesign, with the reason.

| File | Lines | Purpose | Redesign |
|---|---:|---|---|
| `assets/web/index.html` | 96 | Page shell: header (`#project-select` at line 17, `#btn-theme`, `#btn-help`), sidebar `#side-list`, job pane `#job`, chat box `#chat`, status bar, shortcut dialog. Loads `assets/app.css` (line 8) and `assets/js/app.js` (line 94). | Rework. Its `assets/` hrefs are checked by a test (see Risks). No "new run" control, no settings control exists here. |
| `assets/web/app.css` | 638 | All styling, theme variables, responsive drawer. | Rework. It follows whatever layout is chosen. |
| `assets/web/js/app.js` | 230 | Boot: starts the global stream, the views and the selection; owns the status line and theme. Imports chat, jobview, keys, router, sidebar, store, stream, sync, util. | Rework. It is the entry point, so its boot order changes with the layout. |
| `assets/web/js/api.js` | 74 | Fetch wrappers. Exports `ApiError` (line 4), `api` (line 49), `streamUrls` (line 71). `api.runs(limit=200)` (line 52), `api.resume` posts `{}` (line 62), `api.stop`, `api.postChat`, `api.artifactText`. | Keep. Add the new calls the redesign needs (for example a project-filtered run list). |
| `assets/web/js/sidebar.js` | 231 | Project `<select>` (lines 38-51), RUNNING and PAST job lists (lines 161-217), the actor tree of the selected job (lines 71-117). Exports `initSidebar` (14), `renderSidebar` (161), `tickSidebar` (220), `navItems` (229). `keys.js` imports `navItems`. | Rework. It is where complaints 3 and 4 live. |
| `assets/web/js/store.js` | 232 | The client model. Exports `bus`, `emit`, `on`, `state` (line 19), `setProject` (38), `jobOf` (44), `isLive` (69), `setRuns` (82), `putRun` (89), `applyStatePatch` (99), `setDetail` (116), `applyEngine` (129), `applyTranscript` (139), `setChat`, `applyChat`, `sessionsFor` (187), `attemptsOf` (207), `actorPath` (214), `actorOfPath` (227). | Keep, rework the state shape. It holds the project filter (line 27, persisted under `substrate.ui.project`) and the paging size (`pastLimit`, line 28). |
| `assets/web/js/sync.js` | 116 | Loads a job after (re)connect (`catchUp`, line 22). Exports `loadLists` (89) and `loadUsage` (107). `loadLists` calls `api.runs(200)` (line 92). | Keep, rework `loadLists` so the list request carries the project filter. |
| `assets/web/js/stream.js` | 102 | SSE clients. Exports `openGlobalStream` (17) and `openJobStream` (62). | Keep. |
| `assets/web/js/jobview.js` | 621 | The main pane: job header with Stop and Resume, the report, the actor bar, the transcript or log, attempt blocks. Exports `initJobView`, `runView`, `showJob`, `moveActor`, `expandAll` and others. Planner files are shown as markdown (lines 447-448), the task spec at line 458. | Rework. Largest module. Resume is a single button with no model or answer input. |
| `assets/web/js/chat.js` | 123 | Planner chat box. Exports `initChat` (18), `showChat` (38), `onChatChanged` (47). | Keep. |
| `assets/web/js/transcript.js` | 165 | Transcript items, `renderItem` (17), class `Feed` (82). | Keep. |
| `assets/web/js/engine.js` | 114 | Engine log lines from `events.jsonl`. Exports `describe` (15), `renderEvent` (105). | Keep. |
| `assets/web/js/blocks.js` | 157 | Foldable text, diff block, verify block. Exports `foldText`, `expandFolds`, `diffBlock`, `verifyBlock`. | Keep. |
| `assets/web/js/items.js` | 104 | Transcript line to display items and per-session facts. Exports `newCursor`, `itemsOfLine`, `tokensOf`. No DOM. | Keep. |
| `assets/web/js/md.js` | 73 | Small markdown renderer, no HTML pass-through. Exports `markdown` (27). | Keep. |
| `assets/web/js/glyphs.js` | 41 | State glyphs and words. Exports `RUN_GLYPH`, `TASK_WORD`, `TASK_GLYPH`. | Keep. Every state keeps its word. |
| `assets/web/js/router.js` | 41 | URL hash `#/job/<ref>/<actor>`. Exports `parseHash`, `hashOf`, `writeHash`, `listenHash`. | Keep. |
| `assets/web/js/keys.js` | 106 | Keyboard shortcuts. Exports `initKeys` (12). Imports `navItems` from `sidebar.js`. | Keep, rework its sidebar import if the sidebar changes. |
| `assets/web/js/util.js` | 108 | DOM and format helpers (`el`, `fmtDuration`, `fmtCost`, `storeGet`, `storeSet`, and others). Writes no `innerHTML` (header comment, lines 1-2). | Keep. |

Modules other modules rely on most: `util.js` (imported by 9 modules), `store.js` (imported by 8), `api.js` (imported by 5). The `sidebar.js` export `navItems` is used by `keys.js`. No module imports from `test/`.

## Gripe analysis

### 1. Starting a new project or run is hard

Cause in code:
- The HTTP router has exactly three POST routes: `stop` and `resume` (`src/web/routes.ts:141-144`) and `chat` (`src/web/routes.ts:145-148`). Any other path answers `no such route` (`src/web/routes.ts:149`). There is no `POST /api/runs` and no `POST /api/projects`. Searched for both: not found.
- Projects enter the registry only from CLI commands. `registerProject` is called from `src/cli/dispatcher.ts:547`, `src/cli/commands/run.ts:360`, `src/cli/commands/plan.ts:72`, `src/cli/commands/resume.ts:137` and `src/cli/commands/init.ts:132`. Nothing in `src/web/` calls it.
- The empty state tells the user to use the terminal: `assets/web/js/sidebar.js:179-181` shows `substrate run "<request>"` in a project.

Smallest change: add a `POST /api/runs` that takes a project id (from `GET /api/projects`), a request and the two model choices, then starts the CLI detached the same way `resume` does (`src/web/control.ts:48`, which calls `startDetached`). The CLI already has the detach path (`src/cli/detach.ts`), so the web route needs no new engine code. Creating a project directory from the UI would need a separate decision, because the registry is written only by CLI commands.

### 2. Planner and worker model and effort cannot be changed from the UI

Cause in code:
- The resume route reads only `answers` from its body (`src/web/routes.ts:84-97`). Model fields are ignored.
- `resumeRun` builds the command as `["resume", runId]`, plus `--answers -` when answers are given (`src/web/control.ts:43-54`). It never passes `--work` or `--plan`.
- The client resume posts `{}` (`assets/web/js/api.js:62`). No client module refers to models or effort for a resume. Searched `assets/web/js/*.js` for `work`, `plan` and `effort` in a control context: not found.
- No endpoint lists the model catalog. `GET` routes in `src/web/routes.ts:157-234` are health, projects, stream, usage, runs, run, tasks, transcripts, artifacts, engine and chat. No `models` route: not found.

The CLI can already do it: `resume` accepts `--work` and `--plan` and replaces the recorded role (`src/cli/commands/resume.ts:358-371`, see Launch and settings facts (e)).

Smallest change: accept `work` and `plan` strings in `postControl` (`src/web/routes.ts:84-98`), pass them to `resumeRun` (`src/web/control.ts:43-54`) as `--work` and `--plan`, and add the client fields. A `GET` for the catalog would reuse `buildCatalog` (`src/cli/model-catalog.ts:171`).

### 3. Project management is thin; the plan and tasks are not previewed well

Cause in code:
- A project is a `<select>` (`assets/web/index.html:17`, filled in `assets/web/js/sidebar.js:38-51`). There is no project page, no project counts by status and no per-project cost in the UI. The option label shows only `running_count` (`sidebar.js:45`).
- The plan is shown only as artifact text. For a planner actor the job pane lists `plan_file` and `spec` artifacts (`assets/web/js/jobview.js:447-448`) and renders each with `markdown()` (`jobview.js:480`). `manifest.yaml` is therefore rendered as markdown, not as a plan.
- The task spec is shown only after a task is selected, from `GET /api/runs/:ref/tasks/:id` (`assets/web/js/jobview.js:458`, served by `src/observe/task-view.ts:56`).
- Dependency edges are read by the engine view (`src/observe/run-observe.ts:338`) but are not in the run detail's task rows (`src/observe/runs-view.ts:50-64`).

Smallest change: add `depends_on` to `TaskRowApi` (`src/observe/runs-view.ts:50-64`, data already read at `src/observe/run-observe.ts:338`), and render the plan's task list with its spec as a preview on the planner actor instead of raw artifacts.

### 4. The project list is awful with many projects

Cause in code:
- The project picker is one `<select>` with every project (`assets/web/js/sidebar.js:43-47`), with no filter or search.
- The client loads only the 200 newest runs across all projects: `api.runs(200)` (`assets/web/js/sync.js:92`, `assets/web/js/api.js:52`).
- The project filter is applied in the client after that cap: `rows = [...state.runs.values()].filter((r) => state.project === null || r.project_id === state.project)` (`assets/web/js/sidebar.js:166`). The server supports `?project=` (`src/web/routes.ts:71-72`), but the client never sends it. So a project whose runs are not among the 200 newest overall shows no runs. This is a correctness gap, not only a layout one.
- The past list shows 50 at a time (`assets/web/js/store.js:28`, `assets/web/js/sidebar.js:185-196`).

Smallest change: send the selected project to the server (`api.runs` with `&project=<id>`, the query `src/web/routes.ts:71-72` already reads), so the cap applies after the filter.

## Data available

Field lists come from the TypeScript types the routes return. Fields marked "missing" are not in any route today.

### `GET /api/projects` (`src/observe/runs-view.ts:369-375`, built at `runs-view.ts:376-393`)

Present: `id`, `path`, `name`, `last_run_at` (newest run's `createdAt`), `running_count`.
Usable for a project tile: all five.
Missing: count of runs by status, past-run count, cost per project, failed count. The route computes them nowhere: `projectViewsOf` reads every run's journal only to get the newest `createdAt` and the live count (`runs-view.ts:376-390`). Cost per project is available from `GET /api/usage?project=<id>` (`src/web/routes.ts:175-182`, `usageReportOf` in `src/observe/usage.ts:107`), which the client does not call per project. The shape of that report was not read in full.

### `GET /api/runs` (rows are `RunSummary`, `src/observe/runs-view.ts:29-48`, from `summaryOf` at `runs-view.ts:214-248`)

Present: `ref`, `project_id`, `project_name`, `run_id`, `request` (first line, max 200 characters), `status`, `status_word`, `live`, `planner` and `worker` (`provider`, `model`, `effort`), `started_at`, `ended_at`, `elapsed_ms`, `branch`, `merged`, `usage` (tokens and cost), `tasks` (counts: `total`, `passed`, `running`, `failed`, `skipped`), `pause_reason`.
Usable for a run row and a models-used view: all of these.
Caveats:
- `planner` and `worker` come from `requested_roles` on `run.created` (`runs-view.ts:159-177`). Without it they fall back to the first session of each role, and `effort` is then `null` (`runs-view.ts:171`), so effort is not always known.
- The list default is 50 (`src/web/routes.ts:70`); the client asks for 200.
- Missing: estimated cost (not in any route; `estimateRunCost` is called in `src/engine/actions/approve.ts`, its result is not written to the journal), per-run project status counts beyond `tasks`.

### `GET /api/runs/:ref` (`RunDetail`, `src/observe/runs-view.ts:73-84`, built at `runs-view.ts:324-359`)

Adds to the summary: `pause_question`, `verification` (`passed`, `failed`, `skipped`, `not_run`), `verification_note`, `report_text` (`REPORT.md` or `summary.txt`), `tasks` (task rows, see below), `sessions` (`SessionRef`), `planner_session_ids`, `integration` (`verdict`, `verify`, `repairs`), `artifacts` (key, label, kind, bytes, content type), `chat_available`.
Missing: the plan's dependency edges (see below), the parsed manifest (only as the artifact `manifest.yaml`, `src/observe/artifacts.ts`, `add("manifest.yaml", ...)`), the effort a session used (see below), the estimated cost.

Task rows (`TaskRowApi`, `src/observe/runs-view.ts:50-64`, built at `runs-view.ts:259-288`): `id`, `title`, `class`, `state`, `generation`, `attempt`, `session_ids`, `failure_class`, `failure_message`, `files_changed`, `cost_usd`, `elapsed_ms`, `verify` (`passed`, `failed`, `timed_out`, `not_run`, or `null`).
Missing: `depends_on`. It is read from `plan.produced` at `src/observe/run-observe.ts:338`, and `taskRowsOf` returns it (`run-observe.ts:343`), but `taskRowApiOf` drops it.

### `GET /api/runs/:ref/tasks/:id` (`TaskDetail`, `src/observe/task-view.ts:26-38`, built at `task-view.ts:44-86`)

Fields: `task` (the row above), `spec_markdown` (`tasks/<id>.md`, `task-view.ts:56`), `attempts` (each with `generation`, `attempt`, `session_id`, the worker `report`, `verify` with a `full_output` key, `patch` key, `packet` key) and `integration_verify_for_task`.
Missing: the task's `depends_on`, and the spec's front matter, if any. Not checked.

### Sessions and effort

`SessionRef` (`src/observe/transcripts.ts:15-27`) holds `session_id`, `role`, `task_id`, `generation`, `attempt`, `backend`, `model`, `started_at`, `ended_at`, `ok`, `usage`. The transcript header type is `TranscriptHeader` plus `session` (`src/store/transcript.ts:29-31`). Searched `src/observe/transcripts.ts` and `src/store/transcript.ts` for `effort`: not found.
Conclusion: the effort a worker actually used is not recorded per session. The only effort in the API is the requested one (`requested_roles`, `runs-view.ts:159-177`).

### Per-project counts and cost

Per-project counts by status: not in any route. Cost per project: only via `/api/usage?project=`. Estimated cost: not in any route.

## Scale

### Method

- Build: `dist/substrate.mjs` exists (built 2026-10-23 04:48, `ls -la`). Not rebuilt.
- Seed: scratch directory `/home/bsmt-pc/.hermes/cache/scratch/tmp.610rbRrzam` (created with `mktemp -d`, outside the repository). Script `scripts/seed.mjs` writes 40 projects (`projects/p01`..`p40`), each with 25 runs of `events.jsonl` (`run.created` with `requested_roles`, then `run.finished`) and `result.json`. No transcripts, no lock files, no harness. The registry is `state/substrate/projects.json` in the style of `seed()` in `test/e2e/web-ui.test.ts:43-66`. Total 1000 runs.
- Server: `node dist/substrate.mjs ui serve --port 0`, with `XDG_STATE_HOME` and `SUBSTRATE_CONFIG_DIR` in the scratch directory, `SUBSTRATE_SETTINGS` and `SUBSTRATE_PROJECT_DIR` empty, `PATH` starting with `test/fixtures/fake-harness/bin`, and cwd in the scratch directory. No harness ran.
- Trials: three fresh server starts. In each, the first request to each endpoint is "cold", then three more requests to each endpoint on the same server are "warm". Script `scripts/measure.mjs`. Each server was stopped with SIGINT.
- Endpoints: `/api/projects`, `/api/runs?limit=200`, `/api/runs/<ref>` where `<ref>` is `65937739f62f~r_SCALE010013` (project p01, run 13).
- Caveat: cold means first request after a fresh start. The OS page cache was warm because the files were written moments earlier, and no cache drop was possible (no root). The cold numbers therefore measure process start-up and first-call cost, not disk reads.

### Results (milliseconds, `performance.now()` around `fetch` plus body read)

| Endpoint | Cold, 3 samples (first request after start) | Cold median | Warm, 9 samples | Warm median | Body bytes |
|---|---|---:|---|---:|---:|
| `GET /api/projects` | 98.5, 57.7, 59.5 | 59.5 | 53.2, 39.6, 37.7, 41.2, 37.6, 37.1, 41.1, 29.2, 28.7 | 37.7 | 6,681 |
| `GET /api/runs?limit=200` | 58.5, 66.4, 66.5 | 66.4 | 46.2, 40.8, 39.0, 40.8, 39.4, 39.9, 36.0, 30.8, 30.2 | 39.4 | 132,729 |
| `GET /api/runs/<ref>` | 3.1, 3.0, 2.4 | 3.0 | 1.6, 2.0, 1.4, 1.2, 1.4, 1.4, 1.1, 1.1, 1.2 | 1.4 | 917 |

Warm medians: projects 37.7 ms, run list 39.4 ms, run detail 1.4 ms.

### Where the time goes (CPU profile)

One server run with `--cpu-prof`: each of the three endpoints was called once. Profile total sampled time 303.8 ms, including start-up. Inclusive times from `scripts/prof.mjs` (function names as bundled in `substrate.mjs`):

| Function | Inclusive ms | Reads |
|---|---:|---|
| `projectRunsOf` (`src/observe/runs-view.ts:130`) | 84.1 | every run of every project, for both list routes |
| `listRuns` (`src/observe/run-observe.ts:147`) | 79.4 | one `readdir` per project, then `readRun` for each run |
| `readRun` (`run-observe.ts:122`) | 72.4 | `existsSync(events.jsonl)` then the journal |
| `readJournal` (`run-observe.ts:114`) / `readAllSync` | 30.1 | whole `events.jsonl` of each run |
| `recordOf` (`run-observe.ts:129`) | 31.1 | reduces the events, calls `runProcessOf` |
| `runProcessOf` (`src/store/run-lock.ts:152`) | 22.0 | reads `.substrate/state/<runId>.lock` (absent in the seed, so a failed read per run) |
| `projectViewsOf` (`runs-view.ts:369`) | 51.4 | calls `projectRunsOf` (so it is part of the 84.1) |
| `summaryOf` (`runs-view.ts:214`) | 3.2 | 200 rows in the list, `result.json` each |
| `detailOf` (`runs-view.ts:324`) | 1.1 | one run |
| garbage collector | 29.4 self | allocation from parsing 1000 journals |

Reading of the numbers:
- Both list routes pay for reading all 1000 journals. `/api/projects` needs them only for `last_run_at` and `running_count` (`runs-view.ts:376-390`). `/api/runs` needs them to sort and filter before the 200-row cap (`src/web/routes.ts:72-79`).
- The run detail reads one journal, plus the project registry (`listProjects` in `projectOfId`, `runs-view.ts:111-113`, reads the registry and stats every project's directory), which is why it stays near 1.4 ms.
- Growth: the code reads every run on every list request, so the cost grows with the total number of runs, not with `limit`. The 1000-run figure is measured. Any other size is an extrapolation from the code, not a measurement.

Not measured: a larger number of projects, transcripts, lock files, or a warm process after many requests in a busy server. Those would need new seeds.

## Launch and settings facts

### (a) How `run` and `resume` are started detached, and how the run id is found

- `run --detach` and `resume --detach` go through `detachFrom` (`src/cli/detach.ts`, function `detachFrom`, line 10). It removes `--detach` from the arguments (line 24) and calls `startDetached`.
- `startDetached` (`src/util/process-control.ts:92`) creates `.substrate/detached/`, names the log `<unix-ms>-<pid>.log` (lines 94-96), and calls `spawnDetached` (line 97). It sets `SUBSTRATE_DETACHED=1` in the child's environment (line 101).
- `spawnDetached` (`src/util/process-control.ts:64-82`) starts `process.execPath` with `process.argv[1]` (the CLI script, `dist/substrate.mjs`) as a detached child, stdin ignored or piped, output appended to the log, unref'd.
- The run id is found by polling. `runIdOfLockPid` (`src/util/process-control.ts:27-40`) reads each `.substrate/state/*.lock` file and returns the `run_id` whose `pid` equals the child's pid. `startDetached` polls every `POLL_MS = 100` (line 11) until `DETACH_WAIT_MS = 30000` (line 10), with a final scan at lines 130-132.
- On success it prints the run id, pid, `watch`, `status`, `stop` and `log` (`src/util/process-control.ts`, after line 137, and `--output-format json` shape). On failure it prints the log tail and returns the child's exit code, or ends the child and returns 1 (lines 134-145).
- `resume` uses the same path: `src/cli/commands/resume.ts:151`. The web resume also uses it: `src/web/control.ts:48`.

### (b) Project directory and `git init` rules

Documented in `docs/reference/cli.md`, the `run` section (around line 187). Implemented in `src/git/precondition.ts`, function `ensureRepository` (line 61):
- A work tree with a HEAD: proceed, nothing is created (lines 62-65).
- A work tree with no commits: it gets the initial commit only if the top level is the directory itself and it holds nothing except `.git` and `.substrate` (lines 67-75). Otherwise it is refused with `NO_COMMITS_MESSAGE` (line 14): "repository has no commits and is not empty: make an initial commit (git commit --allow-empty -m init) first".
- Not a repository, and the directory holds anything except `.substrate`: refused with `NOT_A_REPO_MESSAGE` (line 12, checked at line 82). The text is the one in cli.md.
- Not a repository and the directory is the home directory: refused with `HOME_REPO_MESSAGE` (line 16, checked by `sameDir(cwd, os.homedir())`, line 85).
- Otherwise: `git init --quiet`, then the commit `substrate: initial empty commit` (line 19, `makeInitialCommit`), and the notice `initialised a new git repository (empty directory)` (`INITIALISED_NOTICE`, line 95).
- Refused also: git not startable ("git is required but could not be started", line 63).
- Substrate never writes git config (cli.md); the precondition module creates no config (not checked line by line).
- Project directory creation: not found. The CLI runs in the current directory and registers it (`registerProject`, see Gripe 1). No `mkdir` for a project was found in `src/cli/commands/run.ts` or `src/git/precondition.ts`.

### (c) `substrate config set` and the planner and worker keys

- `config set` is in `src/cli/commands/config.ts:173-230`. It reads only the target file (`.substrate/settings.json`, or `settings.local.json` with `--local`, line 181), sets the key in that file's own JSON (`setNested`, line 188), then validates the merged result: it folds all layers (`settingsLayers`, then `Contracts.Settings.safeParse(foldLayers(layers))`, lines 190-203). It writes nothing when the result is invalid (`Invalid setting <key>: ...`, lines 205, 217, 223).
- Keys: `roles.planner.backend`, `roles.planner.model`, `roles.planner.effort` (the `Route` schema, `src/contracts/index.ts:352-356`: `backend`, `model`, optional `effort`; `roles.planner: Route`, line 418). `roles.worker.*` is the same shape, partial (`src/contracts/index.ts:420-421`).
- `roles.requested` is set only by `run` and `plan`. A settings file cannot hold it: `assertNoRequestedRolesInFiles` (`src/config/index.ts:312`, called from `loadSettings` at line 345).
- Layer order, lowest to highest (`foldLayers`, `src/config/index.ts:264-278`): defaults, user (`SUBSTRATE_CONFIG_DIR` or `~/.config/substrate`, `settings.json`), project `.substrate/settings.json`, project `.substrate/settings.local.json`, explicit file (`--settings` or `SUBSTRATE_SETTINGS`), environment layer, flags. The last one wins. Requested models for a run go in the flags layer through `withRequestedRoles` (`src/config/index.ts:332-340`), so they beat settings files for that run.

### (d) How `substrate models` builds the catalog, and whether it needs a harness

- `buildCatalog` (`src/cli/model-catalog.ts:171`) reads the cache file first (`readCacheFile`, line 152). The cache path is `modelCacheFile(projectRoot)` = `.substrate/state/models.json` (`src/config/index.ts:372-374`).
- A provider's cached entry is used when the cache is not stale and `--refresh` is not given. Stale means older than `CACHE_MAX_AGE_MS = 24 h` (`src/cli/model-catalog.ts:74`). This path runs no harness.
- Otherwise `buildProviderEntry` (line 105) calls `adapter.validateEnvironment()` (line 112). For Claude it runs `<bin> --version` (`src/backends/adapters/claude.ts:185-190`). Then `adapter.listModels()` runs:
  - Claude: no process. A static list of `CLAUDE_ALIASES` (`haiku`, `sonnet`, `opus`, `fable`, `claude.ts:54`) plus `knownModels` (`claude.ts:231-240`).
  - OpenCode: runs `opencode models --standalone` (`src/backends/adapters/opencode.ts:474-480`).
  - agy: `src/backends/adapters/agy.ts:182`, finds the executable and lists its models.
- Answer: the catalog can be read without running a harness only when a fresh cache exists. Otherwise `--version` runs for each provider, and OpenCode and agy run their own list commands. `--refresh` always does this.

### (e) The plan-review flow, and `resume --work`

How a run ends `planned`:
- A plan-only run forces `permission_mode` `plan` (cli.md `plan` section). In `src/engine/actions/approve.ts`, when the plan is accepted and the mode is `plan`, the engine emits `plan.ready` and then `run.finished` with `status: "planned"`, `exit_code: 0` (`approve.ts:73-75`). The same happens when a `default` permission run needs approval and the mode is `plan` (`approve.ts:64-66`).
- The journal reduces to `PLANNED` (`src/engine/engine.ts:90-91`, `RunSummaryStatus` line 84). The run then shows `planned` in `status`, `runs` and `watch`.

What `substrate resume <id> --work provider:model:effort` does (`src/cli/commands/resume.ts`):
- `recorded` is the run's `requested_roles` from `run.created` (`resume.ts:358`).
- If `--plan` is given, the planner is replaced by it (`resume.ts:363-364`). Otherwise, if `--model` is not given and a recorded planner exists, the recorded planner is used (`resume.ts:365-366`).
- If `--work` is given, the worker is replaced by it (`resume.ts:367-368`). Otherwise, unless `--worker-model` or `--model` is given, the recorded worker is used (`resume.ts:369-370`).
- The flags are first folded into settings overrides by `buildSettingsOverrides` (`resume.ts:361`, the same function `run` uses; `run.ts:128-135` maps `--model` to the worker in `solo` mode and to the planner otherwise).
- A planned run needs a worker: named now or recorded (`resume.ts:381-383`, message "a worker model is required").
- The plan is reviewed before the run goes on: `ingestPlanDraft` must pass, or the command exits 2 and the run stays planned (`resume.ts:393-396`).

The conflict between the two `cli.md` statements:
- `docs/reference/cli.md`, `run` section, Roles bullet: "`resume` does not read them." This is false. `resume.ts:363-368` reads `--plan` and `--work` and applies them.
- `docs/reference/cli.md`, `resume` section, Models bullet: "Naming a role again replaces it for the rest of the run." This is true, and it matches `resume.ts:358-371`.
- The code decides. The `resume` statement is correct. The `run` section sentence should be corrected.

### (f) Questions and answers

- Planner questions are parsed by `parseQuestions` in `src/cli/questions.ts:9-50`. Each numbered item becomes `Q1`, `Q2`, and so on. A `Default:` marker inside an item sets its default.
- `formatAnswers` (`src/cli/questions.ts:57`) turns answers into the text the planner gets back.
- The planner writes `QUESTIONS.md` in the run directory (`src/engine/actions/plan.ts:272-279`; `src/engine/replan.ts:371`). The engine then emits `run.paused` with `reason: "needs_human"`, `questions_path` and the parsed `questions` (`src/engine/actions/plan.ts:413-426`). The run is then `paused` with `pause_reason` `needs_human` (`statusWordOf`, `src/observe/run-observe.ts:96`, shows "paused: needs your answers"). `cli.md` says the CLI exits 3 with a `needs_input` result.
- `resume --answers <file|->` (`src/cli/commands/resume.ts:259-265`, `resume.ts:298-336`): if the run is not paused for questions it exits 2 with "has no pending questions" (line 265). It reads a file or stdin (`-`) and parses `{"answers":[{"id","text"}]}`. Invalid JSON or a missing `answers` array exits 2 (lines 302, 307). An answer for an unknown id exits 2 (line 313). A question left out takes its default. One with no default and no answer exits 2 (lines 326, 336).
- The web UI cannot answer questions. No client module refers to answers (searched `assets/web/js/*.js`, only comments matched). `api.resume` posts `{}` (`assets/web/js/api.js:62`). `postControl` accepts `answers` (`src/web/routes.ts:90-97`), but the client never sends them. A UI resume of a `needs_human` run therefore takes defaults, or fails if a question has no default.

### (g) Where the run's files live, and how to parse the manifest

- Run directory: `.substrate/runs/<run_id>/` (`runDirOf`, `src/observe/run-observe.ts:56`).
- `manifest.yaml`: `<runDir>/manifest.yaml` (`src/engine/actions/approve.ts:22`; `src/engine/engine.ts:63`; artifact key `manifest.yaml` in `src/observe/artifacts.ts`).
- Task specs: `<runDir>/tasks/<id>.md`. The manifest names each one in `tasks[].spec` (for example `tasks/T1.md`; fixture `test/fixtures/spec/snake-plan/manifest.yaml`, lines 17-22). The task view reads them at `src/observe/task-view.ts:56`.
- `decisions.md`: `<runDir>/decisions.md` (`src/archive/index.ts:405`; artifact key `decisions.md` in `src/observe/artifacts.ts`). The replan prompt reads it (`src/engine/actions/replan.ts:89`).
- Parsing: `parseManifest(content, filePath)` in `src/spec/parser.ts:37-53` runs `YAML.parse` and then `Manifest.parse`, and throws `Failed to parse manifest YAML in <file>` on bad YAML. The schema is `Manifest` in `src/contracts/index.ts:77-99`: `version` (literal 1), `run_id`, `goal`, `base_ref`, optional `ecosystem`, `setup` (commands), `contracts` (`files`, `typecheck`), `integration_verify` (commands), `tasks` (`id`, `spec`), optional `budget`. Every object is `.strict()`.
- A real manifest to parse: `test/fixtures/spec/snake-plan/manifest.yaml` (23 lines).

## Risks

1. **The model and question contract is split between CLI and web.** The web resume takes no models and no answers (`src/web/routes.ts:84-98`, `src/web/control.ts:43-54`, `assets/web/js/api.js:62`), while the CLI can replace roles and answer questions (`src/cli/commands/resume.ts:259-371`). A redesign that adds model pickers before fixing this would show controls that do nothing. Mitigation: extend `postControl` and `resumeRun` with `work`, `plan` and `answers` in one change, and add a route test that resumes a planned run with `--work`.

2. **The run list is capped before it is filtered.** `api.runs(200)` (`assets/web/js/sync.js:92`) and the client-side project filter (`assets/web/js/sidebar.js:166`) mean that once the store holds more than 200 runs, runs of a selected project can be missing. Mitigation: send the project to the server (`src/web/routes.ts:71-72` already supports it), and check the sidebar with the 40×25 seed in this audit.

3. **Every list request reads every journal.** `projectRunsOf` reads all runs (`src/observe/runs-view.ts:130-148`), so `/api/projects` and `/api/runs` cost about 38–39 ms at 1000 runs (measured), and grow with the total number of runs. A project-tile design that adds counts or costs per project, computed the same way, multiplies the work. Mitigation: a per-run summary cache keyed by journal size and mtime, or an index file written by the engine. Measure it against the same 40×25 seed before and after.

4. **The data the plan preview needs is not in the API.** `depends_on` is dropped before the API (`src/observe/runs-view.ts:50-64`, source `src/observe/run-observe.ts:338`), there is no estimated cost, the manifest is only an artifact (rendered as markdown, `assets/web/js/jobview.js:447-480`), and no effort is recorded per session. A preview built on today's fields would show a task list without its order. Mitigation: add `depends_on` to `TaskRowApi` and a parsed plan view (using `parseManifest`, `src/spec/parser.ts:37`) before the UI work; bump the API version only if the change breaks clients (`src/web/routes.ts:33`, currently "1").

5. **The static page is pinned by a test.** `test/e2e/web-ui.test.ts:174-176` reads every `href` or `src` in `index.html` that starts with `assets/` and expects `assets/app.css` and `assets/js/app.js` to be served. A redesign that moves the entry point, adds a build step, or renames `assets/` paths will fail that test unless `index.html` keeps those references. Mitigation: keep `assets/app.css` and `assets/js/app.js` as the two entry points, or change the test in the same task. The client has no build step and no `innerHTML` (`assets/web/js/util.js`, header lines 1-2), which the redesign should keep.

Notes on this audit:

- Nothing in the repository was changed except this file. No `npm test`, no real `claude`, `opencode` or `agy`. The server ran with the fake harness first on `PATH`.
- The scratch server was stopped after each trial and after the profile run.
- A separate `substrate.mjs ui serve` process (pid 4353, started 04:02, cwd `/home/bsmt-pc`, no `--port` argument) was already running and was not started by this audit. It was left alone.
