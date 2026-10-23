# Substrate web UI v2: the binding design

Status: DESIGN, binding for the implementation tasks UI1, UI2 and UI3. Task DES. Date 2026-10-23.
Inputs: `docs/design/web-ui-v2/study-patterns.md` (layout study, cited as **patterns**), `docs/design/web-ui-v2/study-look.md` (look study, cited as **look**), `docs/design/web-ui-v2/study-audit.md` (audit of the current client and API, cited as **audit**), `src/web/api-types.ts` (wire types, cited as **wire types**), and `docs/design/web-ui.md` (the earlier design, cited as **web-ui.md**). Where this document and `docs/plan/DECISIONS.md` disagree, DECISIONS wins.

Conventions: "Verified" and "Unverified" are the study's own marks. Nothing here is decided on an Unverified claim alone.

---

## Decision

### The overview: state shelves over dense rows

The project overview (the home screen, route `#/`) lists every project in shelves grouped by state. Each shelf is a heading with a count, and under it dense one-line rows, one row per project. No artwork, no card grid. The shelves are the Steam shelf idea (the owner's suggestion) with state as the shelf name instead of artwork. The rows carry the table features (columns, sort, facets, saved views) from the dense table. This is patterns 14 and 13, built with the facets of pattern 5 and the keys of pattern 7, with a jump box from pattern 9 for finding one project by name. It is the **Candidate 1** of the layout study's recommendation (patterns, Recommendation), with the table of **Candidate 2** inside each shelf. The layout study left the choice to this task; this is the choice.

The four shelves, in fixed order, and each project sits in exactly one shelf (first match wins):

1. **Needs you**: `needs_attention` greater than 0.
2. **Running**: `by_status.running` greater than 0.
3. **Recent**: `last_run_at` within 7 days.
4. **Older**: everything else, including projects that have never run.

The two top shelves are the RUNNING and PAST split that web-ui.md section 1 asks for, with RUNNING split into the two shelves that need a person and run by themselves. PAST is Recent and Older.

### The two cases

**Case 1: 12 projects, 2 running.** The first screen shows, in order: "Needs you (0)" with the text "Nothing needs you.", "Running (2)" with its two rows, "Recent" with the rows updated in the last week, and "Older (10)" collapsed. The two running projects are the first rows the eye meets. Opening "Older" shows the other ten. All 12 rows fit one screen without scrolling when Older is collapsed.

**Case 2: 60 projects, 5 need a person, 8 untouched for three months.** The first screen shows "Needs you (5)" expanded at the top, then "Running (n)", then "Recent", then "Older (…)" collapsed with its count. The eight untouched projects are one click away: the saved view "Untouched 3 months" (see Interaction) lists exactly them. The count changes the heading text, so absence and presence are read without colour.

### Rejected alternatives

1. **Steam-style artwork tiles (pattern 1).** Rejected. Its only source is the Steam FAQ, which returned no body text, and the snippets are Unverified. Substrate projects have no artwork, so a tile would be a generic card, and the tile hides the state and cost the owner needs. Pattern 1 scores Low on fit. The Steam idea survives as shelves.
2. **Card dashboard (pattern 6, the study's option C).** Rejected. At 60 projects the five that need a person are scattered across a long scroll, with six to nine cards per screen (patterns, Scale test, C). It fails Case 2 unless it is grouped by state, and grouped by state it becomes this design with cards. Vercel's card layout was not read (Verified only that projects are listed and open a dashboard), so no card pattern is rested on.
3. **One dense table sorted by last activity, with no shelves (pattern 5 and 7 alone).** Rejected as the overview. At 60 rows the five that need a person are hidden unless the default sort puts them first, and a default sort is one more thing the owner must know to find them (patterns, Scale test, B). Shelves make the state the first thing read. The dense rows are kept inside the shelves.
4. **Lazygit-style two panes (pattern 8).** Rejected for the overview. Its detail pane needs one selected item, and the overview has none. Its state signal is colour-coded (patterns, pattern 8, the README), which the study warns against. Pattern 8 stays a candidate for the run screen only, which this design already uses (the actor bar and the transcript are the existing list-plus-detail layout that Unchanged keeps).
5. **Kanban by state (pattern 4).** Rejected. Its columns read well, but drag-to-change is wrong because the engine sets state, and at 60 items the columns need per-column collapse that the shelves already give.

### Evidence used, and what is not relied on

- **Relied on, Verified:** Linear's saved and shared views and the URL copy model (patterns, pattern 5); k9s's `/` filter, `:` command bar and sort keys (pattern 7); Raycast's keyboard-first launcher (pattern 9); the Claude Code agent view grouping by "Needs input" and "Working", which web-ui.md section 2.1 records (verified in that document's own study).
- **Relied on, measured:** the audit's 1000-run seed. Both list routes read every journal and take about 38 to 39 ms warm (audit, Results). The shelves need the same data, so the overview adds no reads beyond what the list already does. The counts in `ProjectStats` (wire types) must be computed in the same single pass over the runs, not by a second read (audit, Risks 3).
- **Not relied on, Unverified:** the Steam shelves and their sort order (patterns, pattern 1); Plex and Jellyfin rows (pattern 3); the Vercel card layout. The "Needs you" shelf is supported by the Claude Code grouping and by the owner's own requirement, not by Steam.

### Disagreements between the studies, and which finding was followed

- **Two lists or four shelves.** web-ui.md section 1 asks for "two lists: RUNNING jobs and PAST jobs". The layout study recommends four shelves. Followed: the four shelves, with RUNNING and PAST kept as the top and bottom groups. Nothing in the design shows a run in two groups.
- **Steam shelves sorted by date added.** Two Steam snippets disagree: a 2019 post describes no such sort, a 2023 snippet says shelves can be sorted by date added (patterns, Sources). Followed: neither. The design sorts by the Substrate field `last_run_at`, which needs no Steam behaviour.
- **Colour-free state in the dense table.** The layout study warns that colour-only state would fail (patterns, Reversal evidence). Followed: each state has a text tag and word (see Look).
- **Ranking of the look.** The look study ranks Plate first and says Ember moves to second only if the accent may appear in the chrome. Followed: Plate, with the accent kept out of the chrome (see Look). The brand element that Ember offers, the hexagon, is borrowed in a neutral colour so the chrome stays Plate.

### What would reverse this choice

- The owner, shown the design, says the first thing they want at 12 projects is which project it is, not what state it is in. Then a card dashboard (pattern 6, grouped by state) is the prototype to try.
- The owner mostly opens the same few projects. Then a recents-first tile row above the shelves outranks the shelves. The shelves already keep "Recent", so the change is one shelf made first.
- User testing shows the state tags are too faint in the dense rows, so the owner misses "failed" rows. Then the tag gets a stronger treatment: the word in `text` colour and the tag in bold. The rule of the shelves does not change.
- The overview's data call takes more than 100 ms warm at 1000 runs after API1 (measured by the audit's method). Then the per-run summary cache in audit Risk 3 becomes a precondition, and the shelf order stays.

---

## Look

### Direction

The direction is **D Plate** from the look study, with one borrowed element from **C Ember**: the hexagon outline from the mark, drawn in the `muted` token. Plate's rules hold: system fonts, neutral surfaces, the accent only for focus and selection, status written as a bracketed word, no shadows, no motion.

Why Plate: it is the study's first-ranked direction for a tool read all day (look, Recommendation). The owner asked for Hydrocarbon Forge branding "but mostly Substrate". Plate's top bar carries the word "Substrate" alone, which matches that. The hexagon, from the mark, is the one brand element that does not compete with status, because it is never coloured with a status token and never uses the accent.

Rejected directions, each with the reason it lost:

- **A Ledger.** The serif heading stack, `"Iowan Old Style"` and Palatino, varies by platform, so the look is not the same across the owner's machines. Brass accent sits in the status row. Its warm paper light theme is the second choice if Plate is rejected.
- **B Bench.** Monospace-first with pure `#121212` and near-white text. The look study measures 16 : 1 for body text, which it calls harsh over a full working day. It is also too close to a terminal for a browser UI the owner asked to look designed.
- **C Ember.** The most branded, but its ember accent is the most saturated colour in the set and competes with the status colours all day. Its condensed headings rely on Arial Narrow or Roboto Condensed, which are not on every Linux system. The hexagon borrowed from it is the only part kept.

Brand presence, decided: the top bar has the 14 px hexagon outline in `muted` before the word "Substrate" in `text`. The favicon is `favicon.svg`. The Settings "About" panel shows `logo.png`. The footer has one line, "Substrate, from Hydrocarbon Forge". No other place carries the mark.

### Colour tokens

Each token is a CSS custom property on `:root` (dark is the default) and on `:root[data-theme="light"]`. The theme follows the operating system unless the owner picks one (see Interaction, "Theme").

| Token (CSS name) | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#101418` | `#eef2f6` | Page background |
| `--surface` | `#171c22` | `#ffffff` | Rows, panels, dialogs, the top bar |
| `--line` | `#303a46` | `#aeb9c6` | 1 px rules. Decorative only (1.60 : 1 and 1.77 : 1 on `--bg`), never the only edge of a control |
| `--text` | `#e2e8f0` | `#111827` | Body text, names, headings |
| `--muted` | `#9aa6b5` | `#4b5563` | Secondary text, control borders, the mark, and the glyphs of planned, paused and cancelled |
| `--accent` | `#6cb2ff` | `#1a56a8` | Focus outline, selected row bar, primary button fill |
| `--run` | `#6cc8f0` | `#0c5a80` | Running tag and word |
| `--ok` | `#6fd38f` | `#1d6a3f` | Finished tag and word |
| `--warn` | `#ebc35e` | `#78500a` | Needs answers and needs you tags and words |
| `--err` | `#ff8e8e` | `#a3201f` | Failed tag and word |

The primary button is `--accent` fill with `--bg` text. Its contrast is the accent-on-background ratio in the table below.

### Type

- Body stack: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. No web fonts, no CDN.
- Monospace stack, for IDs, paths and the run reference only: `ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`.
- Sizes: body 14 px; meta text and mono IDs 12.5 px; page title 16 px at weight 600; section headings 14 px at weight 600, sentence case; shelf headings 14 px at weight 600 with the count in the same line.
- Numbers in counts and cost columns use `font-variant-numeric: tabular-nums` and are right-aligned.
- Weights 400 and 600 only. No italics.

### Spacing, radius, elevation

- A 4 px grid. Tokens `--space-1` 4 px, `--space-2` 8 px, `--space-3` 12 px, `--space-4` 16 px, `--space-6` 24 px.
- Row height 30 px. Row padding 4 px 8 px.
- Radius: rows 0; controls and buttons 2 px; dialogs 2 px. Nothing above 4 px.
- No shadows. Panels and rows are separated by a 1 px `--line` rule and whitespace.
- Focus: a 2 px `--accent` outline with a 2 px offset. It is an outline, not a box shadow.

### Status: glyph and word for each run state

Every state shows its glyph, then its word, in the token colour. The word is always present, so no state depends on colour. The glyph is a bracketed tag so it reads without colour in any font.

| Run state (and reason) | Tag | Word | Token |
|---|---|---|---|
| running | `[run]` | running | `--run` |
| planned (awaiting approval) | `[plan]` | planned | `--muted` |
| paused, needs answers | `[ask]` | needs answers | `--warn` |
| paused, held by a person | `[hold]` | paused | `--muted` |
| failed | `[fail]` | failed | `--err` |
| finished | `[done]` | finished | `--ok` |
| stopped | `[stop]` | stopped | `--text` |
| interrupted | `[intr]` | interrupted | `--warn` |
| cancelled | `[cxl]` | cancelled | `--muted` |

A project row shows the needs-you tag `[ask]` with the word "needs you" and the count, or else the tag of its newest run. Task states in the plan use the same tag set (`TASK_GLYPH` and `TASK_WORD` in `glyphs.js`), with "not started" for a null state.

Reading the table: `[plan]` and `[hold]` and `[cxl]` are `--muted`, which is 7.48 : 1 dark and 6.72 : 1 light on `--bg`, above the 3 : 1 the non-text rule needs. Words are always set in `--text`, so the word stays readable whatever the tag colour; no tag or glyph is set in `--line`.

### Generic tells: the rule each is checked against

Each row is a habit the look study lists as generic (look, Generic tells), the one-line rule this design uses instead, and the check `scripts/check-web-client.mjs` runs (UI1 creates it).

1. Purple or blue-to-violet gradients on buttons, headers or hero. Rule: one flat fill per surface, from a token. Check: no `gradient(` in any stylesheet under `assets/web/`.
2. Identical rounded cards with soft shadows. Rule: rows and panels are separated by a `--line` rule and whitespace; no shadow. Check: no `box-shadow` in the stylesheets.
3. Centred hero heading with a sub-line and two buttons. Rule: the app opens on the shelves, left-aligned, with no hero. Check: no `text-align: center` in `shell.css` or `library.css`.
4. Emoji used as icons. Rule: state uses the bracketed tags and words in the table above, and icons are inline SVG or CSS shapes. Check: no code point in the emoji ranges in `assets/web/` text.
5. Translucent blur panels. Rule: opaque `--surface` with a 1 px `--line`. Check: no `backdrop-filter`, and no `rgba(` used as a surface colour.
6. Uniform large radius. Rule: 0 for rows, 2 px for controls, nothing above 4 px. Check: no `border-radius` above 4 px.
7. Grey-on-grey secondary text. Rule: `--muted` meets 4.5 : 1 on `--bg` and `--surface` in both themes (see Accessibility). Check: the contrast pairs in this document, re-run by the implementation's test.
8. Decorative glows, grain, spotlights. Rule: flat backgrounds; no pseudo-element used for decoration. Check: no `radial-gradient`, no image used as a background, no `::before` or `::after` with `content` other than the disclosure arrow.
9. Stat-tile rows of large numbers. Rule: counts are inline text in the shelf and page headings, with tabular numerals. Check: no element with a font size above 16 px carrying a count.
10. Rotating words, marquees, scroll-reveal. Rule: no decorative motion at all. Check: no `@keyframes` and no `transition` in the stylesheets.
11. Status shown by a coloured dot alone. Rule: every state is a tag and a word, from the table above. Check: each state string in `glyphs.js` has a non-empty word.
12. Pill-shaped pastel badges on every label. Rule: plain text labels; at most one filled element per row, which is the selection bar. Check: no `border-radius` of 999 px or more.
13. Hover lift on cards and buttons. Rule: hover changes the background colour only. Check: no `transform` in any `:hover` rule.
14. Display face for headings at 28 px or larger. Rule: no heading above 16 px, separated by weight and spacing. Check: no `font-size` above 20 px in any stylesheet.

### Motion

- No decorative motion. No `@keyframes` and no `transition` property in any stylesheet.
- The elapsed time of a running run updates once per second as text. It does not animate.
- Reduced motion: there is nothing to reduce, so no `prefers-reduced-motion` rule is needed. The rule is the absence of motion, and the check is the list above.

### Iconography

- The hexagon outline is an inline SVG with `stroke="currentColor"` and no fill. It is 12 px in rows and 14 px in the top bar.
- Disclosure arrows on shelf headings are CSS shapes made from borders.
- No icon font, no image icons, no emoji. State icons are the bracketed tags.

### Where the mark appears

| Place | What | Source |
|---|---|---|
| Top bar | 14 px hexagon outline in `--muted`, then the word "Substrate" in `--text` | inline SVG |
| Browser tab | favicon | `assets/web/brand/favicon.svg`, linked from `index.html` as `/assets/brand/favicon.svg` |
| Project rows | 12 px hexagon outline in `--muted` before the name | inline SVG |
| Settings, "About" | `logo.png` at 96 px inside a 1 px `--line` frame | `/assets/brand/logo.png` |
| Footer | "Substrate, from Hydrocarbon Forge" | text |

`logo.png` has an opaque black canvas, so on the light theme it shows as a dark framed box. That is accepted; the About panel is the only place it appears.

---

## Screens

Every screen renders into the single `#main` region under the top bar (see Module map). The top bar is the same on every screen:

```text
+----------------------------------------------------------------------------+
| (hex) Substrate   [ Find a project            ]  [New run]  [Theme: system] |
+----------------------------------------------------------------------------+
| Library / api-gateway / run 4f2a                  (breadcrumb, screens b, c)|
+----------------------------------------------------------------------------+
```

The top bar buttons are "New run", "Theme: system" (cycles to "Theme: dark" and "Theme: light"), and "Shortcuts". The find box on the top bar is the jump box (see Interaction). A "Skip to content" link is the first focusable element.

### (a) Library home, route `#/`

Wireframe:

```text
+----------------------------------------------------------------------------+
| (hex) Substrate   [ Find a project            ]  [New run]  [Theme: system] |
+----------------------------------------------------------------------------+
| Views:  [Needs me 5]  [Running 2]  [Untouched 3 months 8]  [Save view]     |
| Group: (State) (Age) (None)   Sort: [Last activity v]   State: [Any v]     |
| Age: [Any v]   Clear filters                                              |
+----------------------------------------------------------------------------+
| v Needs you (5)                                                            |
|   [ask] needs you  api-gateway       3/12 tasks   $1.20  2 h ago  RRDAF    |
|   [ask] needs you  billing-sync      0/4 tasks    $0.31  1 d ago  AD       |
| v Running (2)                                                              |
|   [run] running    snake-game        6/9 tasks    $0.84  now      RRDR     |
| > Recent (4)                                                               |
| > Older (10)                                                               |
+----------------------------------------------------------------------------+
```

Each row, left to right: the muted hexagon, the state tag and word, the project name (a link to `#/project/<id>`), the tasks count, the cost, the last activity, and the history strip (the letters of the newest 12 runs, newest first; see the legend in the table below).

History letters: `R` running, `P` planned, `A` needs answers, `H` paused and held, `F` failed, `D` finished, `S` stopped, `I` interrupted, `C` cancelled. A row's history is `aria-hidden`; the row's label carries the same information (see Accessibility).

Data to fields:

| On screen | Field (wire types or existing API) |
|---|---|
| Project name | `GET /api/projects` `name` |
| Project path (tooltip, and project screen) | `path` |
| Needs-you count, shelf 1 membership | `ProjectStats.needs_attention` |
| Running count, shelf 2 membership | `ProjectStats.by_status.running` |
| Row state tag | the needs-you tag when `needs_attention` is above 0; else the running tag when `by_status.running` is above 0; else the tag of `last_run.status` |
| Tasks count | `last_run.tasks_passed` of `last_run.tasks_total`, as `3/12 tasks` |
| Cost | `ProjectStats.cost_usd` and `cost_source` (see cost text rule below) |
| Last activity | `last_run_at` (existing); shelf 3 uses it as well |
| History strip | `ProjectStats.recent` `status` values, newest first, at most 12 |
| Run count on the project screen | `ProjectStats.runs_total` |
| Last request on the project screen | `ProjectStats.last_run.request` |

Cost text rule: `cost_usd` null, or `cost_source` "unknown", shows "no cost"; "computed" shows the value with " est." after it; "reported" shows the value alone. Values are `$` and two decimals.

Relative time: "now" under one minute, "N min ago", "N h ago", "N d ago", and a date `YYYY-MM-DD` after 30 days. A project with no run shows "never".

Shelves, with the labels and default open state:

- "Needs you (N)", always rendered, open. Empty text: "Nothing needs you."
- "Running (N)", always rendered, open. Empty text: "Nothing is running."
- "Recent (N)", rendered only when not empty, open.
- "Older (N)", rendered only when not empty. Collapsed when N is above 15, otherwise open.

With "Group: Age" the shelves are "Today", "This week", "This month", "Last 3 months", "Older than 3 months" and "Never run". With "Group: None" there is one shelf, "All projects (N)".

States:

- Loading: the `#main` region shows "Loading projects..." and `aria-busy="true"`.
- No projects: heading "No projects yet." Text: "A project is a git repository where Substrate has run. Start a run with New run, or run `substrate run` in a repository on the command line." Button: "New run".
- No match: "No project matches these filters." Button: "Clear filters".
- Error: "Could not load projects. " followed by the server's message text, unchanged. Button: "Try again".

Buttons and labels, exactly: "New run", "Save view", "Clear filters", "Try again", "Shortcuts", "Theme: system", "Theme: dark", "Theme: light". Group buttons: "Group: State", "Group: Age", "Group: None". Sort select, label "Sort", options "Last activity", "Name", "Cost". State select, label "State", options "Any", "Needs you", "Running", "Failed". Age select, label "Age", options "Any", "Today", "This week", "This month", "Last 3 months", "Older than 3 months", "Never run". Find box, label "Find in this list". Views row label "Views".

### (b) Project screen, route `#/project/<project_id>`

Wireframe:

```text
+----------------------------------------------------------------------------+
| (hex) Substrate   [ Find a project            ]  [New run]  [Theme: system] |
+----------------------------------------------------------------------------+
| Library / api-gateway                                                      |
| api-gateway                                             [New run here]     |
| /home/me/work/api-gateway                                                  |
| Runs 58   Running 1   Needs you 1   Cost $14.20                            |
+----------------------------------------------------------------------------+
| Settings                                                                   |
|  Planner model  [ provider/model v ]  Effort [ Default v ]  from project file |
|  Worker model   [ provider/model v ]  Effort [ Default v ]  built-in default   |
|  Save to [ This project (shared) v ]  [Save settings]                      |
|  [Use default for planner]  [Use default for worker]                       |
+----------------------------------------------------------------------------+
| Runs                                                                       |
|   [ask] needs you  add retry to uploads     5 h ago   3/12   $0.44         |
|   [run] running    snake game               now       6/9    $0.84         |
|   [done] finished  fix login redirect       2 d ago   8/8    $1.02         |
|   Show more runs (8 more)                                                  |
+----------------------------------------------------------------------------+
```

Data to fields:

| On screen | Field |
|---|---|
| Project name, path | `name`, `path` from the project entry in `GET /api/projects` |
| Counts line | `runs_total`, `by_status.running`, `needs_attention`, `cost_usd` and `cost_source` (`ProjectStats`) |
| Planner model, effort, source | `ProjectSettingsApi.planner` (`model`, `effort`, and `backend` in the provider select), `sources.planner` |
| Worker model, effort, source | `ProjectSettingsApi.worker`, `sources.worker` |
| Run rows | `GET /api/runs?project=<project_id>&limit=<N>` (`RunSummary`): `ref`, `request` (first line), `status`, `pause_reason`, `started_at`, `elapsed_ms`, `tasks`, `usage` |
| Model choices | `GET /api/models` (`ModelsApi`) |

Source labels, from `sources`: "project" reads "from project file", "local" reads "from this machine's file", "user" reads "from your user settings", "default" reads "built-in default", "unset" reads "not set".

Settings fields and buttons, exact labels: "Planner model", "Worker model" (selects with a first option "Default"), "Effort" beside each (first option "Default"), "Save to" (options "This project (shared)" which maps to scope `project`, and "This machine only" which maps to scope `local`), "Save settings", "Use default for planner", "Use default for worker". A save sends only the fields the person changed. "Default" sends `null`, which removes the field. Save success: the live region says "Settings saved."

Run list: the first 50 runs, then "Show more runs (N more)" which raises the limit by 50 and requests again. Rows in the shelf order of the overview: "Needs you", then "Running", then "Past". Past rows are the others, newest first. The run row is a link to `#/job/<ref>`.

Run launcher: "New run here" opens the launcher (see Interaction) with Project fixed to this project and its name shown as text.

States:

- Loading: "Loading runs..." in the Runs section; settings show "Loading settings...".
- No runs: "This project has no runs yet." Button: "New run here".
- Settings error: "Could not load settings. " and the server's message, unchanged. Button: "Try again".
- Save error: the server's message, unchanged, shown above the buttons. Nothing is shown as saved.
- Unknown project (the id is not in the registry): "No project with this id." Link: "Back to all projects".

### (c) Run screen, route `#/job/<ref>` and `#/job/<ref>/<actor>`

Wireframe:

```text
+----------------------------------------------------------------------------+
| (hex) Substrate   [ Find a project            ]  [New run]  [Theme: system] |
+----------------------------------------------------------------------------+
| Library / api-gateway / run 4f2a                                           |
| [ask] needs answers   Add retry to uploads                                 |
| Branch substrate/retry   Merged no   Cost $0.44 (est.)   Tokens 84k in 12k out   Elapsed 14 min |
| [Stop]  [Send answers and resume]                                          |
+----------------------------------------------------------------------------+
| Plan                                              Estimate $1.80 (3 tasks) |
|  Layer  Task               State        Depends on   Est.    Cost   Verify |
|  0      T1 Retry queue     [done] finished  -           $0.40  $0.38  pass |
|  1      T2 Upload handler  [run] running    T1           $0.60  $0.06  -    |
|  1      T3 Docs            [plan] planned   T1           $0.20  -      -    |
| Questions                                                                  |
|  Q1  Retry count?   [ textarea                ]                            |
+----------------------------------------------------------------------------+
| Models used                                                                |
|  Role     Model        Effort  Sessions  Tokens in/out  Cost     Source   |
|  planner  opus         high    1         20k / 3k       $0.14    reported |
+----------------------------------------------------------------------------+
| Actors: Planner | Engine | T1 | T2 | T3          (existing actor bar)        |
| Transcript, engine log, chat (existing modules, unchanged)                 |
+----------------------------------------------------------------------------+
```

Header data to fields (`RunDetail`, which extends `RunSummary`): `request` (the first line, full text on the page), `status` and `pause_reason` (the tag), `branch`, `merged`, `usage` for cost and tokens with `cost_source`, `elapsed_ms` (a live value, updated once a second as text while running), `run_id` in the breadcrumb (first 4 characters of `run_id` shown, full value in a tooltip).

Run controls. The buttons shown depend on the state:

| Run state | Buttons, in this order | Notes |
|---|---|---|
| running | "Stop" | While the request is pending the label is "Stopping..." |
| paused, needs answers (`pause_reason` needs human answers) | "Send answers and resume", then "Stop" | Questions form above the buttons, one textarea per question from `PlanPreview.questions` |
| planned (plan ready, not yet run) | "Approve and run" | With a worker picker: "Worker model", "Effort". Recorded worker is preselected |
| failed | "Resume" | |
| paused (held), interrupted, stopped | "Resume" | |
| finished, cancelled | none | Text: "Finished." or "Cancelled." |

"Approve and run" and "Resume" post `ResumeRequest`: `worker` is set for approval and absent for other resumes; `answers` is set only from the questions form and contains only the non-blank answers, keyed by question `id`. A blank worker for approval shows "Choose a worker model before approving." and sends nothing.

Plan preview, from `PlanPreview`:

| Column | Field |
|---|---|
| Layer | `tasks[].layer` |
| Task | `id` and `title` |
| State | `state` (tag and word from `TASK_GLYPH` and `TASK_WORD`), "not started" when null |
| Depends on | `depends_on`, joined with a comma, or "-" |
| Est. | `est_usd`, or "-" |
| Cost | `cost_usd`, `$` and two decimals; "-" when 0 |
| Verify | the task row's `verify`: "pass", "fail", "timeout", "not run", or "-" |

Plan heading: "Plan" with the estimate at the right: "Estimate $X (N tasks)" from `estimate_usd`, or "No estimate" when null. Plan goal from `goal` is shown under the heading.

Models-used panel, from `models_used` (`ModelUsedApi`): columns "Role" (`role`), "Model" (`model`), "Effort" (`effort`, or "-"), "Sessions" (`sessions`), "Tokens in/out" (`input_tokens` and `output_tokens`), "Cost" (`cost_usd`), "Source" (`cost_source`, written as "reported", "computed" or "unknown"). Panel heading: "Models used".

States for this screen:

- Loading: "Loading run..." in `#job`.
- Error: "Could not load this run. " and the server's message, unchanged. Link: "Back to all projects".
- Plan loading: "Loading plan...". Plan not yet produced (`has_plan` false): "The planner has not produced a plan yet."
- Plan error: "Could not load the plan. " and the server's message. Button: "Try again".
- Models-used empty: "No model has run yet."
- Questions: "The planner needs answers before it can go on." above the form; an empty required answer is not a client error, the server's message is shown unchanged if it refuses.

The existing transcript, engine and chat panes keep their states and wording (Unchanged).

---

## Interaction

### Keyboard map

| Keys | Where | Action |
|---|---|---|
| `Ctrl+K` or `Cmd+K` | everywhere | Open "Jump to project" (the jump box, below) |
| `/` | library | Move focus to "Find in this list" |
| `n` | everywhere, outside a text field | Open the launcher, "New run" |
| `j` and `k`, or Down and Up | library | Move focus to the next or previous row |
| `Enter` | library, on a focused row | Open that project's screen |
| `g` then `l` | everywhere | Go to the library `#/` |
| `g` then `p` | project and run screens | Go to this project's screen |
| `Esc` | dialogs | Close the dialog, and return focus to the control that opened it |
| `Esc` | library, find box with text | Clear the find text |
| `Tab` and `Shift+Tab` | everywhere | Move through the focus order (see Accessibility) |
| `?` | everywhere, outside a text field | Open "Shortcuts" |

Run-screen keys that exist today in `keys.js` for the transcript and actor bar keep their behaviour; they are not changed by this design. The shortcut dialog lists the keys in the table above and the transcript keys together.

### Jump box

The find box in the top bar and the "Jump to project" dialog use one matcher (`jumpMatches` in `filters.js`). The matcher is case-insensitive, and each project name is scored: a prefix match ranks first, then a substring match, then the letters of the query in order anywhere in the name (a subsequence). Ties are broken by `last_run_at`, newest first. The dialog shows at most 10 results. Up and Down move the selection, Enter opens the project, Esc closes. The dialog's label is "Jump to project" and its input is labelled "Project name". With no results it shows "No project matches "<text>"."

### Filter and group model

The view has five facets and one grouping. Each is a field of the view object:

- `group`: `state` (default), `age`, or `none`.
- `sort`: `activity` (default; newest `last_run_at` first, never-run last), `name` (ascending, case-insensitive), or `cost` (highest `cost_usd` first, unknown last).
- `state` facet: `any` (default), `needs`, `running`, or `failed`. `failed` means `last_run.status` is "failed".
- `age` facet: `any` (default), `today`, `week`, `month`, `quarter`, `older`, or `never`. Buckets are exact: `today` is under 1 day, `week` under 7 days, `month` under 30 days, `quarter` under 90 days, `older` 90 days or more. `never` is no run.
- `q`: the find text. The name matcher above filters the list.

Facets combine with AND. A project is shown only when it passes all facets. Shelves are then built from the shown projects by the `group` rule. Counts in headings are the shown projects in each shelf.

Saved views are named objects holding a view. Three are built in and cannot be deleted: "Needs me" (`state` needs, `group` state), "Running" (`state` running, `group` state), and "Untouched 3 months" (`age` older, `group` none, `sort` activity). The person can save the current view with "Save view", which asks for a name in the dialog. A saved view is kept in browser storage under the key `substrate.ui.views`. Names are trimmed. Errors: a blank name shows "Name the view."; a name already in use shows "A view named <name> already exists."; more than 20 saved views shows "Delete a view before saving another." Each view chip shows its count of matching projects. "Delete view" appears only for the person's own views.

### URL hash

View state lives in the URL hash, so a reload or a copied link opens the same view. The hash has three forms:

- `#/` is the library. Its view state follows after a `?`: `#/?group=state&sort=activity&state=needs&age=any&q=snake`. Keys that are at their default are left out. A value that is not known is ignored, and the view uses the default for it.
- `#/project/<project_id>` is a project screen.
- `#/job/<ref>` and `#/job/<ref>/<actor>` are a run screen, with the actor as the existing actor path (`Planner`, `Engine`, or a task id).

The router writes the hash with a history entry on each navigation, and with no entry when the view facets change (so Back leaves the library, not each filter). `router.js` parses it into a route object (see Module map).

### Launcher and validation

The launcher opens in the one `<dialog>` (id `dialog`). Its title is "New run". Fields, in order, with their exact labels:

1. "Project": a select listing project names in alphabetical order, and the last option "New project". On a project screen this is fixed and shown as text.
2. "New project name": shown only when "New project" is chosen.
3. "Parent folder": shown only when "New project" is chosen. It is the folder the new project goes in. Its help text: "The new project is created in this folder."
4. "What should the run do?": a textarea. Required.
5. "Plan only: wait for my approval before any code runs": a checkbox. When checked, the request sends `review: true` and the "Mode" choice is greyed out with the text "Mode is ignored for a plan-only run."
6. "Mode": "Auto" or "Solo" (default "Auto").
7. "Planner model" and "Planner effort", each with a first option "Project default" and the models from `GET /api/models`.
8. "Worker model" and "Worker effort", the same.
9. "Max budget USD (optional)": a number field.

Buttons: "Start run" (submit) and "Cancel". While the request is in flight, "Start run" reads "Starting..." and is disabled. On success the dialog closes and the app opens `#/job/<ref>` of the accepted run; the live region says "Run started."

Client validation, run before sending. Each message appears under its field:

- Blank request: "Say what the run should do. The request cannot be blank."
- Project name invalid (not 1 to 64 characters of letters, digits, dots, dashes and underscores, and not starting with a dot): "Use 1 to 64 letters, digits, dots, dashes or underscores. Do not start with a dot."
- Project name already exists (compared case-insensitively with the names from `GET /api/projects`): "A project named <name> already exists. Choose it from the list."
- Parent folder blank when creating a project: "Enter the folder the new project goes in."
- Model not in the catalog (a saved or chosen model id that `GET /api/models` does not list for that backend): "The model <id> is not in the catalog. Pick one from the list."
- Budget not a number above 0: "Max budget must be a number above 0."

Server errors: the server refuses a launch with its own message. The dialog shows that message text exactly as the server returned it, in the alert region above the buttons, with no rewording and no added prefix. The client does not define those messages; API1 and API2 define them. A server refusal leaves the fields as typed.

---

## Module map

The client is plain ES modules under `assets/web/`, served with the leading `assets/` and without the `web/` segment, so `assets/web/css/tokens.css` is linked as `assets/css/tokens.css`. The single script entry is `assets/js/app.js` (served from `assets/web/js/app.js`), as the e2e test requires. Stylesheet entry is `assets/app.css`. Images are linked with a leading slash.

### Shared DOM ids and routes

| Id or route | Owner | Meaning |
|---|---|---|
| `#main` | UI1 | The single route region. Every screen renders into it |
| `#job` | UI3 | The run screen's root, inside `#main` (existing id) |
| `#chat` | existing | The planner chat box, inside `#job` (unchanged) |
| `#live` | UI1 | Polite live region for announcements |
| `#crumbs` | UI1 | Breadcrumb in the top bar |
| `#dialog` | UI1 | The one `<dialog>` for the launcher, jump box, save-view and shortcuts |
| `#find` | UI1 | The top-bar find box (the jump box input) |
| `#views` | UI1 | The saved-view chip row in the library |
| `#settings-panel` | UI2 | The settings block on the project screen |
| `#plan` | UI3 | The plan preview block on the run screen |
| `#controls` | UI3 | The run control bar on the run screen |
| `#models-used` | UI3 | The models-used panel |
| Route `#/` | UI1 | Library |
| Route `#/project/<id>` | UI2 | Project screen |
| Route `#/job/<ref>[/<actor>]` | UI3 | Run screen |

### Files: owner, exports and their shapes

Names are exact. Each function's return is described in prose. Parameter order is as written.

**UI1 creates or rewrites** (all under `assets/web/`):

- `index.html` (rewrite). Top bar with `#find`, `#crumbs`, the theme button and the "New run" button; `#main`, `#live`, `#dialog`. Links, in this order: the favicon `/assets/brand/favicon.svg`; `assets/css/tokens.css`; `assets/app.css`; `assets/css/shell.css`; `assets/css/library.css`. Script: `assets/js/app.js` as the only `type="module"` script. The links for UI2 and UI3 files are added with those files (see Edge cases).
- `app.css` (rewrite). Base element rules only. Keeps its path because the e2e test serves it. Imports nothing; the link order does the cascade.
- `js/app.js` (rewrite). Boot: mount the shell, initialise keys, load the project list, then dispatch the current route. Exports nothing. Keeps its path.
- `js/router.js` (rewrite). Exports `parseHash(hash)`, which returns a route object `{screen, id, actor, query}` where `screen` is `"library"`, `"project"` or `"job"`, `id` is the project id or run ref, `actor` is the actor path or null, and `query` is a record of the library's hash query keys. Exports `hashOf(route)`, which returns the hash string for a route. Exports `writeHash(route, {push})`, which sets the hash, pushing a history entry when `push` is true. Exports `listenHash(fn)`, which calls `fn(route)` on each hash change and returns nothing.
- `js/store.js` (rewrite). Keeps the existing run functions and names (`bus`, `emit`, `on`, `state`, `jobOf`, `isLive`, `setRuns`, `putRun`, `applyStatePatch`, `setDetail`, `applyEngine`, `applyTranscript`, `setChat`, `applyChat`, `sessionsFor`, `attemptsOf`, `actorPath`, `actorOfPath`). Replaces `setProject` and the project filter with `setProjects(list)`, which stores the `GET /api/projects` list (each entry is the project plus `ProjectStats`) and returns nothing, and `projectById(id)`, which returns the entry or null. The paging size moves to `state.runPage`, default 50.
- `js/api.js` (rewrite). Exports `ApiError` (unchanged shape), `streamUrls` (unchanged), and `api`, an object of methods: `projects()` (the list), `runs({project, limit})` (the run list, `project` optional), `run(ref)`, `plan(ref)` (`PlanPreview`), `models()` (`ModelsApi`), `projectSettings(id)` (`ProjectSettingsApi`), `saveProjectSettings(id, update)`, `launch(request)` (`LaunchAccepted`), `resume(ref, body)` (`ResumeRequest`), `stop(ref)`, `postChat(ref, text)`, `artifactText(ref, key)`. Every POST sends `Content-Type: application/json` and the header `X-Substrate-UI: 1`. A non-2xx response throws `ApiError` whose `message` is the server's message text, unchanged.
- `js/sync.js` (rewrite). Exports `loadProjects()`, which fetches the project list into the store and returns nothing; `loadUsage` (unchanged); and the catch-up function for a job (unchanged name). `loadLists` is removed.
- `js/sidebar.js` (rewrite; the file keeps its name and holds the saved-view chips). Exports `renderViews(container, onPick)`, which draws the view chips with counts and calls `onPick(view)` with the chosen view, returning nothing; and `saveCurrentView(name, view)`, which validates and stores a view and returns `{ok, error}`.
- `js/keys.js` (rewrite). Exports `initKeys()`, which binds the global keys in the table above and returns nothing, and `KEY_LIST`, the array of `{keys, label}` rows the shortcut dialog prints.
- `js/glyphs.js` (rewrite). Keeps the names `RUN_GLYPH`, `TASK_WORD`, `TASK_GLYPH`, and adds `RUN_WORD`. Values are the tags and words in the Look table. Every state has a word.
- `js/util.js` (keep). Keeps its exports. Adds `relativeTime(iso, now)`, which returns the relative text described in Screens (a), and `costText(usd, source)`, which returns the cost text rule from Screens (a). `util.js` writes no `innerHTML`.
- `js/library.js` (new). Exports `renderLibrary(main, route)`, which draws the library into `main` from the store and the route's query, returning nothing; and `refreshLibrary()`, which redraws the open library when the store changes, returning nothing.
- `js/filters.js` (new). Exports `parseView(query)`, which returns a view object with the facets above and their defaults; `viewToQuery(view)`, which returns the query record with default keys left out; `shelvesOf(projects, view, now)`, which returns an array of `{key, label, projects}` in shelf order; `ageBucket(lastRunAt, now)`, which returns `"today"`, `"week"`, `"month"`, `"quarter"`, `"older"` or `"never"`; `jumpMatches(projects, text, limit)`, which returns the matching project entries in rank order; and `savedViews()`, `putView(name, view)`, `deleteView(name)`, which read and write `substrate.ui.views` and return `{ok, error}` for the put and delete.
- `js/tile.js` (new). Exports `projectRow(entry)`, which returns the `<li>` for a project with its link, tag, counts, cost, activity, history and an `aria-label`; `runRow(run)`, which returns the `<li>` for a run summary, for the project screen; `stateTag(status, pauseReason)`, which returns the tag element for a run state; `shelfHeading(label, count, open, onToggle)`, which returns the heading button with `aria-expanded`.
- `js/viz.js` (new). Exports `historyStrip(recent)`, which returns the `aria-hidden` element of the history letters; and `taskCountText(passed, total)`, which returns `"3/12 tasks"`, or `"no tasks"` when the total is 0.
- `js/shell.js` (new). Exports `mountShell()`, which builds the top bar into the page and returns `{main, setCrumbs(items)}` where `items` is an array of `{label, href}`; `announce(text)`, which writes to `#live`; `openDialog(title, node, returnFocus)`, which fills `#dialog` and opens it, returning nothing; `closeDialog()`, which closes it and restores focus; and `openJump(projects)`, which opens the jump box in the dialog.
- `css/tokens.css` (new). The custom properties in the Look tables, dark on `:root`, light under `:root[data-theme="light"]`, the spacing, radius and font tokens.
- `css/shell.css` (new). Top bar, breadcrumb, dialog, skip link, focus outline, the phone layout.
- `css/library.css` (new). Shelves, rows, the history strip, the view chips and the filter row.
- `brand/logo.png` (new). The file from `hydrocarbon-forge-website/assets/logo.png`, copied in with its opaque canvas. Linked with a leading slash.
- `brand/favicon.svg` (new). The favicon from the same folder. Linked with a leading slash.
- `scripts/check-web-client.mjs` (new). Runs the checks listed under Generic tells over `assets/web/` and exits 1 on a failure.

**UI2 creates** (under `assets/web/`):

- `js/project.js`. Exports `renderProject(main, projectId)`, which draws the project screen, loads settings, models and runs, and returns nothing.
- `js/composer.js`. Exports `openLauncher(opts)`, where `opts` is `{projectId}` with `projectId` null for the library, which opens the launcher dialog and returns nothing; `validateLaunch(values, projects, models)`, which returns `{errors, request}`, where `errors` maps field names to the messages above and `request` is a `LaunchRequest` or null when there are errors; and `submitLaunch(request)`, which calls `api.launch` and returns the `LaunchAccepted`.
- `js/settings-panel.js`. Exports `settingsPanel(projectId, settings, models)`, which returns the settings block element; and `saveSettings(projectId, update)`, which calls `api.saveProjectSettings` and returns the saved `ProjectSettingsApi`.
- `js/models.js`. Exports `loadModels()`, which returns a promise of `ModelsApi`, fetched once per page load; `modelChoices(models, role)`, which returns `{value, label, backend, model, efforts}` rows for the pickers (`role` is `"planner"` or `"worker"` and is used only to order the rows); `effortsFor(models, backend, model)`, which returns the effort list of a model, empty when none; and `isKnownModel(models, backend, model)`, which returns a boolean.
- `css/project.css` and `css/composer.css`.

**UI3 creates or rewrites** (under `assets/web/`):

- `js/jobview.js` (rewrite). Keeps its exports `initJobView`, `runView`, `showJob`, `moveActor`, `expandAll`. `showJob(ref, actor)` now draws the run header, `#controls`, `#plan` and `#models-used` above the existing actor bar and transcript.
- `js/plan-view.js` (new). Exports `renderPlan(container, plan)`, which draws the plan preview from `PlanPreview` into `container` and returns nothing.
- `js/run-controls.js` (new). Exports `renderControls(container, run, plan, onDone)`, which draws the buttons for the run state and calls `onDone()` after a successful action; and `actionsFor(status, pauseReason)`, which returns the ordered list of action keys: `"stop"`, `"resume"`, `"approve"` or `"answer"`, empty for a finished or cancelled run.
- `js/models-used.js` (new). Exports `modelsUsedPanel(rows)`, which returns the panel element for `ModelUsedApi[]`.
- `js/chat.js` (may rewrite, keeps its exports `initChat`, `showChat`, `onChatChanged`).
- `css/plan.css` (new).
- `docs/reference/ui.md` (rewrite of the reference for the new screens; written by UI3 only).

Shared exports that other tasks call: `util.js` (`el`, `fmtDuration`, `fmtCost`, `relativeTime`, `costText`), `tile.js` (`stateTag`, `shelfHeading`), `models.js` (`loadModels`, `modelChoices`, `effortsFor`), `shell.js` (`announce`, `openDialog`, `closeDialog`, `setCrumbs` through `mountShell`), `api.js` (`api`, `ApiError`). UI2 and UI3 import these; nothing else crosses between the three tasks.

### CSS load order and index.html link order

1. `assets/css/tokens.css`
2. `assets/app.css`
3. `assets/css/shell.css`
4. `assets/css/library.css`
5. `assets/css/project.css`
6. `assets/css/composer.css`
7. `assets/css/plan.css`

Tokens come first so that every later file reads the custom properties. The later files only add rules for their own screens and do not override a token. Within the stylesheet list, each file's selectors use its screen's root id (`#main` for the shell, `#` followed by the library, project or job section id for the screens).

---

## Accessibility and responsive

### Contrast

The ratios are the look study's own, computed with the WCAG 2.x relative luminance formula in its Contrast section, reused here for the Plate direction. The required levels are 4.5 : 1 for text and 3 : 1 for non-text marks and focus.

| Pair | Dark | Light | Requirement |
|---|---|---|---|
| `--text` on `--bg` | 15.00 | 15.77 | 4.5 |
| `--text` on `--surface` | 13.90 | 17.74 | 4.5 |
| `--muted` on `--bg` | 7.48 | 6.72 | 4.5 |
| `--muted` on `--surface` | 6.93 | 7.56 | 4.5 |
| `--accent` on `--bg` (focus, selected bar, primary label on accent) | 8.32 | 6.35 | 3.0 focus; 4.5 for the label |
| `--accent` on `--surface` (focus) | 7.71 | 7.14 | 3.0 |
| `--run` on `--bg` | 9.83 | 6.69 | 4.5 |
| `--run` on `--surface` | 9.10 | 7.53 | 4.5 |
| `--ok` on `--bg` | 10.03 | 5.86 | 4.5 |
| `--ok` on `--surface` | 9.29 | 6.59 | 4.5 |
| `--warn` on `--bg` | 11.01 | 6.33 | 4.5 |
| `--warn` on `--surface` | 10.20 | 7.12 | 4.5 |
| `--err` on `--bg` | 8.38 | 6.71 | 4.5 |
| `--err` on `--surface` | 7.76 | 7.54 | 4.5 |
| `--muted` glyph on `--bg` (planned, held, cancelled) | 7.48 | 6.72 | 3.0 |
| `--line` on `--bg` | 1.60 | 1.77 | none: decorative only |

Every required pair passes in both themes. `--line` is never the only edge of a control and never the colour of a status glyph. Control borders use `--muted`.

### Focus order

Within a screen, focus moves in this order: "Skip to content" (the first stop), the top bar (the mark, the find box, "New run", "Theme", "Shortcuts"), the breadcrumb, then the screen's controls in reading order. On the library, that is the views row, the group, sort, state and age controls, the find box, then each shelf heading and its rows top to bottom. On the run screen, it is the header, the control bar, the plan, the models-used panel, the actor bar, the transcript and the chat box, in the order the page draws them. Opening a dialog moves focus into it; closing it returns focus to the control that opened it. Focus is never trapped outside a dialog.

### Screen reader text

A project row is one `<li>` with a `aria-label` built from the row's fields, in this shape: "<name>. <state word>. <needs text, when any>. Last activity <relative time>. Cost <cost text>." Example: "api-gateway. needs you. 2 runs need an answer. Last activity 2 hours ago. Cost $1.20." The name is the link's text, and the state word follows it. A shelf heading is a button whose text is "Needs you, 5 projects, expanded" or "Older, 10 projects, collapsed", driven by `aria-expanded`. The history strip is `aria-hidden`, because the row's label already says the state. A run row's label uses the same pattern with the run's status word.

The `#live` region announces: "Run started.", "Run stopped.", "Settings saved.", "Run approved.", and the server's message text for a failed action.

### Status without colour

Every status is a bracketed tag and a word, so the tag, the word and the shelf heading carry the state with no colour. The history strip uses letters. A failed run is "failed" in words and `[fail]` in the tag, whatever the colour. No state is given by colour alone anywhere in the design.

### Responsive: under 720 px

- The top bar wraps to two rows. Row one has the mark, the word "Substrate" and "New run". Row two has the find box, full width. "Theme" moves into the Settings "About" panel.
- The view controls (group, sort, state, age, save view) sit behind one button, "Filter and sort", which opens them in the dialog. The views row scrolls sideways.
- A project row becomes two lines: the name with its tag on the first, then the tasks count, cost and activity on the second. The history strip is hidden on phones; the tag and words carry the state.
- Buttons and select controls are at least 40 px high on this layout. Row links fill the row width.
- The run screen's plan table scrolls sideways inside its own box; the header and controls stack.

### Checks

The generic-tell checks are run by `scripts/check-web-client.mjs` (UI1). The contrast pairs are re-run by the implementation's own test against the token values in this document. A failing check is a fix to the stylesheet, never a change to the values in this document.

---

## Unchanged

These keep their behaviour, their wording and their modules. The implementation tasks may not restyle or rename them beyond what their own screens need:

- The transcript: `transcript.js`, `items.js`, `blocks.js` (folds, the diff block, the verify block), and `md.js` (no HTML pass-through). The transcript view inside the run screen keeps its wording.
- The engine journal: `engine.js` and its log lines.
- The chat: `chat.js` keeps `initChat`, `showChat` and `onChatChanged`, and the chat box keeps its send behaviour and its planner context. Its button stays "Send".
- The stream: `stream.js` keeps `openGlobalStream` and `openJobStream`, and the `Last-Event-ID` resume behaviour.
- Stop, Resume and Chat behave as they do today on the server: `POST /api/runs/<ref>/stop`, `POST /api/runs/<ref>/resume` and `POST /api/runs/<ref>/chat`. The client's extra fields for resume (`worker`, `answers`) are additions, and a resume with no body still resumes the run as before.
- The POST guards: the `X-Substrate-UI` header and the `Content-Type: application/json` requirement stay on every POST. The Host check stays for a localhost bind and is skipped for any other bind, as web-ui.md section 5.0 states. No guard is removed or weakened.
- `util.js` keeps its helpers, and its rule of writing no `innerHTML`.
- `glyphs.js` keeps its export names; its values change to the Look table.
- `store.js` keeps the run functions listed under Module map.
- The run words in the run header keep their source: the status word comes from the server's `status_word`.
- The static file routes of `server.ts` keep serving `assets/` as they do now, and `test/e2e/web-ui.test.ts` keeps finding `assets/app.css` and `assets/js/app.js`.
- Server work is out of scope here (API1 and API2). The screens above assume the wire types in `src/web/api-types.ts`; no wire type is changed by this design.

---

### Edge cases

- **Counts without cost.** A project whose runs are all unpriced shows "no cost", not "$0.00". `cost_usd` null is never shown as zero.
- **Cost computed rather than reported.** Shown with " est." after the value, so the owner can tell a computed estimate from a reported figure.
- **A run with no recorded worker.** The approval picker is empty and the approval button stays disabled until a model is chosen. The server's "a worker model is required" text is shown if it refuses.
- **A planned run whose plan is not yet there.** The run is `planned` but `has_plan` is false: the plan area shows "The planner has not produced a plan yet." and "Approve and run" is still offered only when the server reports the run as planned.
- **A saved model no longer in the catalog.** The picker shows the saved value with the words "(not in the catalog)" and does not select it silently; the person picks one or uses "Default".
- **An unknown `pause_reason`.** The tag is `[hold]` with the word "paused", and the raw reason is shown in the run header's tooltip. Nothing is hidden.
- **Sixty projects, five needing answers, eight untouched.** Covered in Decision. The untouched view is the built-in view "Untouched 3 months".
- **More than 200 runs.** The project screen loads by project, so the cap of the old client (audit, Gripe 4) cannot hide a project's runs. The overview uses `ProjectStats`, not the run list.
- **Interrupted runs.** Tagged `[intr]` and listed under "Needs you" only when `needs_attention` counts them. Resume is offered.
- **Old saved views with unknown keys.** Ignored; the view uses the defaults for the keys it cannot read.
- **Where the studies disagree.** Covered in Decision (two lists or four shelves; Steam sort order; colour-free state; the look ranking).
- **Unverified claims.** The Steam, Plex, Jellyfin and Vercel-card claims are Unverified in the study and are not used to decide any screen. The Claude Code grouping is taken from web-ui.md, which read it on the source pages.
- **The sequencing of the shared entry files.** `index.html` and `app.js` are the only files that name every screen. The links and imports for `project.js`, `composer.js`, `settings-panel.js`, `models.js`, `plan-view.js`, `run-controls.js`, `models-used.js`, `project.css`, `composer.css` and `plan.css` are added by the task that creates each file, because the e2e test serves every referenced asset and a link to a file that does not yet exist fails it. The implementation task writing the file also writes its one link or import line. Where a task's write list does not include `index.html` or `app.js`, the owner adds them before that task starts. This is the one place the module map needs the owner's confirmation.
- **Empty `runs` and an unknown project id.** The project screen shows "No project with this id." and a link back to the library. The same for an unknown run ref on the run screen, which shows the error state.

---
