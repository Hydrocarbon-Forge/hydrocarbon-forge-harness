# Substrate project overview: how UIs present many items

Status: STUDY, not a decision. Task ST1. Date 2026-10-23. It informs the later design task that chooses the project overview layout. It does not choose the visual identity or palette. Convention follows section 2 of `docs/design/web-ui.md`: each finding is marked **Verified** (read on a page or run in a product during this study) or **Unverified** (general knowledge, or a search snippet that was not opened).

Context: Substrate runs coding jobs ("runs") inside git repositories ("projects"). The owner has dozens of projects with many runs each. The current flat list is the problem. The owner floated a Steam-library tile shelf "or maybe something better".

---

## Sources

Opened and read during this study (URL, what was read, result):

- https://code.claude.com/docs/en/agent-view is cited by `docs/design/web-ui.md` section 2.1; not re-opened in this study. Findings below that cite it are taken from that document and marked as such.
- https://lazygit.dev/ not opened; the GitHub repository was used instead.
- https://github.com/jesseduffield/lazygit: **read**. Panels named (branches view, commits view, main view), `/` filter, `<tab>` between panes, commit colours (green, yellow, red) with meanings, PR state shown by icon colour.
- https://github.com/derailed/k9s: **read**. Table views per resource, `:` command bar, `/` filter (`/!` invert, `/-l` label, `/-f` fuzzy), `shift-o`/`shift-n`/`shift-a`/`shift-p`/`shift-s` sorting, `ctrl-w` wide columns, status colours from a skin file.
- https://www.raycast.com/: **read**. Tagline "Your shortcut to everything"; "A collection of powerful productivity tools all within an extendable launcher"; keyboard-first, extensions.
- https://linear.app/docs/custom-views: **read**. Filtered views of issues, projects, initiatives; "New view"; save a filtered board or list as a view; workspace views versus team views; copy a view's URL, but the view must be shared first; owner per view; starring pins a view to the sidebar.
- https://vercel.com/docs/projects/overview: **read** (documentation page, not the dashboard UI). Says a project "groups deployments, domains, environment variables"; "You can view all projects in your team's Vercel dashboard"; selecting a project opens its project dashboard. No description of card layout was in the page.

Attempted but not readable (kept so the failure is visible):

- https://help.steampowered.com/en/faqs/view/2A05-0F2A-B08D-CF1F (Steam FAQ): returned the page chrome and language list only; no body text. Steam library claims below are therefore **Unverified**.
- https://support.plex.tv/articles/continue-watching/: HTTP 403. Plex claims are Unverified.
- https://linear.app/docs/views: HTTP 404. Replaced by the custom-views page above.
- https://jellyfin.org/docs/general/clients/web/: HTTP 404. Jellyfin claims are Unverified.
- https://docs.gitlab.com/ee/user/project/: opened; contained only project-creation text. Not used.

Search snippets only (not opened; treated as Unverified):

- Steam community and press pages returned by a web search for "Steam library collections shelves sort filter recent games help". Snippets said: a "Recent Games" shelf exists on the Home tab (2019 community post); Collections and Shelves can be sorted by date added (PCGamesN, 1 Aug 2023 update); shelves sort by release date, hours played or Metacritic score (PCGamesN); filters can build dynamic collections. The snippets are dated 2019 to 2023 and may be out of date. These URLs are not listed as opened because they were not opened.

Not checked at all: itch.io app, GOG Galaxy, GitHub Projects, htop, btop, Spotlight, treemap and heatmap tools, strategy-game minimaps, timeline and swimlane tools, Netlify, Portainer. Claims about these are general knowledge and are marked Unverified.

Disagreements: none between the sources read. The Steam snippets disagree with each other on whether shelves can be sorted by date added (one snippet says yes from the 2023 update; the 2019 post describes no such option). Both claims are kept; the 2023 snippet is the later one.

---

## Patterns

Each pattern lists: what it is; sources; how it scales to 12, 40 and 150 items; how state is shown without colour alone; build cost in plain HTML, CSS and ES modules; fit for Substrate (high, medium or low, with one reason).

### 1. Steam library tiles, shelves and collections

- **What it is:** A grid of large game capsules (artwork tiles). Items sit in named shelves or collections, a "Recent Games" row, and a sort and filter bar. The owner's own suggestion.
- **Sources:** Steam FAQ (not readable). Snippets: "Recent Games" shelf; shelves sortable by date added, release date, hours played or Metacritic; dynamic collections from filters. **Unverified**.
- **Scale:** 12 items fit one screen with no scroll. At 40 the shelves need horizontal scroll or collapse, and the artwork tile itself is the cost. At 150 a tile grid needs a shelf per group and a search box; the tiles stop carrying information because the artwork is not data.
- **State without colour:** Needs a text badge or icon on each tile. Steam-style art has no room for status, so state has to be an overlay. **Unverified**.
- **Build cost:** Low to medium. CSS grid and `overflow-x: auto` rows. The art needs a placeholder for every project, since Substrate has no artwork. Without art the tile becomes a generic card (see section 6).
- **Fit for Substrate:** **Low.** Substrate's items have no artwork, and the tile hides the state and the cost that the owner needs to see. A tile row can work for a "Recent" strip (see pattern 3), not as the main view.

### 2. itch.io app or GOG Galaxy library

- **What it is:** Library list or grid of purchased or installed titles, with install state, filters by platform and tag.
- **Sources:** Not opened. **Unverified** general knowledge.
- **Scale:** Like Steam. Grid works to about 40, list beyond.
- **State without colour:** Install and update states as text labels. **Unverified**.
- **Build cost:** Low. Standard list and grid.
- **Fit for Substrate:** **Medium.** A list with install-state labels is close to what Substrate needs; the grid part is not.

### 3. Plex and Jellyfin shelves ("Continue Watching", "Next Up", "Latest")

- **What it is:** Horizontal rows of posters, each row with a purpose. The top row is "continue", meaning things that are in progress.
- **Sources:** Plex and Jellyfin pages were not readable (403, 404). **Unverified**.
- **Scale:** Rows are capped (a few items each); scale comes from the number of rows, not items. 12, 40 and 150 items each show a handful of rows, so the screen stays readable. The weakness is finding a specific item beyond the rows.
- **State without colour:** Progress bar plus a label such as "Next up". **Unverified**.
- **Build cost:** Low. A row component plus `overflow-x`.
- **Fit for Substrate:** **High** as a *pattern for the top of the page*: a "Needs you" row, a "Running" row and a "Recent" row. Its value is that it answers "what should I look at now" in the first second. It does not replace a full list.

### 4. Kanban board (columns by state)

- **What it is:** Cards in columns, each column a state. Moving a card changes its state.
- **Sources:** Not opened; Linear board views were not read (the list/board page was 404). **Unverified**.
- **Scale:** Works well to about 40 cards across 5 columns. At 150, columns become long and need per-column collapse and counts.
- **State without colour:** The column name is the state, which is text. Good. **Unverified**.
- **Build cost:** Medium. Drag and drop, which Substrate does not need because state is set by the engine, not the user.
- **Fit for Substrate:** **Medium.** Column-by-state reads well for "Running / Needs you / Finished / Failed". Drag-to-change is wrong for Substrate, since the user cannot move a run between states.

### 5. Table or list with faceted filters (Linear views, GitHub Projects)

- **What it is:** A list of rows with a filter bar. Filters are facets (status, assignee, label). A filtered list can be saved as a view.
- **Sources:** Linear custom views: **Verified** (read on https://linear.app/docs/custom-views). Facet filters, "New view", saving a filtered view, workspace and team scopes, URL copy, owner, starring to sidebar. GitHub Projects not read: **Unverified**.
- **Scale:** Scales well to 150 when grouped and filterable. At 12 the filter bar is overkill.
- **State without colour:** Status as a text column; Linear's and GitHub's exact status rendering not read. **Unverified** for the visual form.
- **Build cost:** Low to medium. A table with a filter state object serialised to the URL hash.
- **Fit for Substrate:** **High.** Facets and saved views are exactly what the owner needs at 60 projects. It is the backbone for the list part of the overview.

### 6. Dashboard of cards (Vercel, Netlify, Portainer)

- **What it is:** One card per project, each showing name, last deployment, and status.
- **Sources:** Vercel projects overview: **Verified** that projects are listed in a team dashboard and each opens a project dashboard. The card layout itself was not in the page read. Netlify and Portainer: **Unverified**.
- **Scale:** Cards in a wrapping grid. 12 fits. At 40 it is a long scroll. At 150 it needs search and grouping, and cards are the least dense option.
- **State without colour:** Card badge with a text label such as "Failed". **Unverified** for these products.
- **Build cost:** Low. CSS grid.
- **Fit for Substrate:** **Medium.** Good at 12 projects; poor density at 60. Works if the card shows the project's state, not just its name.

### 7. Dense terminal monitor (k9s, htop, btop)

- **What it is:** Full-screen table of resources; a `:` command bar switches resource type; `/` filters; keys sort.
- **Sources:** k9s GitHub README: **Verified** (`:` command, `/` filter with invert, label and fuzzy modes; `shift-` sort keys; `ctrl-w` wide columns; status colour from skin). htop and btop: **Unverified**.
- **Scale:** Designed for hundreds of rows. At 150 it is the densest and fastest. At 12 it is sparse but fine.
- **State without colour:** k9s uses colour from a skin file (`frame.status`), so colour is primary; text status column is still present. **Verified** that colours are configurable; whether text alone suffices was not checked.
- **Build cost:** Low in HTML (a `<table>` with sticky header and keyboard handling). Keyboard handling is the main work.
- **Fit for Substrate:** **High**, given the owner already uses terminal UIs. The `/` filter and `:` jump map directly onto the search and command-palette ideas. The risk is that the owner finds it too sparse for "needs a person" signals.

### 8. Lazygit-style panels (sidebar list, main view, state colour)

- **What it is:** Several panes side by side: a list on the left (branches, commits, files), a main view on the right showing detail. `<tab>` moves focus.
- **Sources:** lazygit GitHub README: **Verified** (panes named branches, commits and main view; `/` filter; `<tab>` between panes; commit colour meanings green, yellow, red; PR state as icon colour). Only the README text was read, not the running UI.
- **Scale:** The list pane scrolls; works to 150 with `/` filter. Detail pane is per item.
- **State without colour:** lazygit relies on colour for commit state (green, yellow, red) per the README. **Verified** as a colour-coded design; text fallback not stated. This is a warning for Substrate.
- **Build cost:** Medium. Two panes with a focus model.
- **Fit for Substrate:** **Medium.** Good for list plus detail (the job view). Weak as the overview because the overview has no single "detail" to show.

### 9. Command-palette launcher (Raycast, Spotlight)

- **What it is:** A text box that finds any item or action; results are a ranked list.
- **Sources:** Raycast homepage: **Verified** ("Your shortcut to everything"; "A collection of powerful productivity tools all within an extendable launcher"; keyboard-first). Spotlight: **Unverified**.
- **Scale:** Scales to any count because only the top results show. At 12 it is overkill on its own.
- **State without colour:** Results carry a text subtitle. **Unverified** for Raycast's exact result layout.
- **Build cost:** Low. An input and a filtered list; keyboard navigation.
- **Fit for Substrate:** **High** as a *companion*, not as the overview. It is the fastest way to find one project among 60. It does not show state at a glance.

### 10. Map or minimap with alerts (strategy games)

- **What it is:** A spatial overview of many units with alerts drawn on the map.
- **Sources:** Not opened. **Unverified** general knowledge.
- **Scale:** Works well for many items if they have location. Substrate projects have no spatial position.
- **State without colour:** Alert icons. **Unverified**.
- **Build cost:** High for an informative map.
- **Fit for Substrate:** **Low.** Projects have no natural position; a map would invent one.

### 11. Treemap or heatmap (cost or activity by project)

- **What it is:** Rectangles sized by a value (cost, runs) or a grid coloured by activity.
- **Sources:** Not opened. **Unverified** general knowledge.
- **Scale:** Good at 40 and 150 for showing relative size; poor for finding one item by name.
- **State without colour:** Heatmap needs a value legend and a text value; colour alone fails. **Unverified**.
- **Build cost:** Medium. Squarified treemap in SVG or CSS; no library.
- **Fit for Substrate:** **Low** for the overview; **medium** as a small "cost by project" widget. It answers "where is the money going", not "what needs me".

### 12. Timeline or swimlane (runs over time, lanes per project)

- **What it is:** Horizontal time axis; one lane per project; bars for runs.
- **Sources:** Linear project views hint at ordering by target date (from the custom-views page, a partial mention only). Timeline tools not opened: **Unverified**.
- **Scale:** Lanes scroll vertically; 150 lanes is a lot unless lanes collapse. 12 lanes is clear.
- **State without colour:** Bar labels and shape. **Unverified**.
- **Build cost:** Medium to high (time scale, zoom).
- **Fit for Substrate:** **Medium.** Useful for "what ran when"; the overview question is about now, not history.

### 13. Grouped sidebar tree (projects, then runs)

- **What it is:** A tree in the left column: project, then its runs, with groups above (RUNNING, PAST).
- **Sources:** Claude Code agent view grouping (Pinned and needing input, Ready for review, Needs input, Working, Completed) and status icons are cited in `docs/design/web-ui.md` section 2.1. Not re-read in this study: **Unverified here**, verified in the design document's own study.
- **Scale:** Tree collapses; works to 150 if project nodes collapse by default. The number of visible rows is the limit.
- **State without colour:** Group headings are text ("Needs input", "Working"), and icons come with words. Good.
- **Build cost:** Low. Nested `<ul>` with a disclosure control.
- **Fit for Substrate:** **High.** This matches the agreed RUNNING and PAST structure in `web-ui.md`, and the state groups make "needs a person" visible without colour.

### 14. Shelves by state (Steam-like, but state rows instead of art)

- **What it is:** The Steam shelf idea, with shelves named by state ("Needs you", "Running", "Recent", "Older") and dense rows in each shelf, not art tiles.
- **Sources:** Steam shelves (Unverified, see pattern 1) plus the grouping in pattern 13.
- **Scale:** Each shelf collapses; counts on each shelf heading. Scales to 150 because only the open shelves render.
- **State without colour:** The shelf name is the state. Good.
- **Build cost:** Low.
- **Fit for Substrate:** **High.** It keeps the Steam idea the owner liked and drops the artwork that carries no data here.

---

### Pattern summary

| # | Pattern | Verified sources? | Fit |
|---|---|---|---|
| 1 | Steam tiles and shelves | No (snippets) | Low |
| 2 | itch.io / GOG Galaxy | No | Medium |
| 3 | Plex/Jellyfin rows | No | High (top row only) |
| 4 | Kanban by state | No | Medium |
| 5 | Table with faceted filters | Linear: yes | High |
| 6 | Card dashboard | Vercel: partly | Medium |
| 7 | Dense terminal table | k9s: yes | High |
| 8 | Lazygit panes | README: yes | Medium |
| 9 | Command palette | Raycast: yes | High (companion) |
| 10 | Map with alerts | No | Low |
| 11 | Treemap or heatmap | No | Low (widget) |
| 12 | Timeline or swimlane | No | Medium |
| 13 | Grouped sidebar tree | Via web-ui.md | High |
| 14 | Shelves by state | No (derived) | High |

### Vocabulary for projects with runs

**Facets that earn their place** (each reason follows):

- *Status* (running, planned, paused, finished, failed, stopped, interrupted): the reducer's run statuses, already defined in `web-ui.md` section 3. Needed for every view.
- *Needs attention* (a boolean derived from status: waiting on a plan answer, paused, failed, or `QUESTIONS.md` present): this is the owner's main question. It should be a single facet, not a combination the user builds.
- *Activity age* (last event time, bucketed: today, this week, this month, older): finds the 8 untouched projects in the scale test. Bucketed, not free-form.
- *Cost* (total spend, sortable; a threshold filter is optional): useful to sort, weak as a facet.
- *Name* (text search, fuzzy): always present. k9s and Raycast show a text filter is the fastest finder.
- *Model* (planner and worker model): earns its place only as a filter when the owner switches models often. Low priority.
- *Project* (folder or project name): needed for the all-projects view.

**Groupings that earn their place:**

- *Shelves by state* (Needs you, Running, Paused, Failed, Finished): the first grouping. Pattern 13 and 14.
- *By recency* (today, this week, older): second grouping, pairs with activity age.
- *By folder* (repository path prefix, when several projects share a parent): useful only when the owner keeps projects in folders. Not assumed.

**Saved and shared views:**

- The view state (filters, grouping, sort, search) serialises to the URL hash, for example `#view=needs-me&sort=age&q=snake`. This needs no backend and survives a reload. Linear's "copy a view's URL" is the model, but Substrate needs no sharing permissions because the UI is local.
- Pinned views in the sidebar, as Linear stars views into the sidebar: a short list of named views the owner keeps. Stored in `ui.json` or browser storage; the backend need not know.

### Generic or machine-made look to avoid

Short list. Visual identity is a later study.

- Identical rounded cards in a grid, each with the same shadow. Looks like a template. Studied products used dense rows (k9s, Linear list) instead.
- Purple-to-blue gradients on the header or buttons.
- Centred hero text with a large headline on a dashboard. The overview should start with the list, not a banner.
- Emoji used as icons for state (for example a check mark emoji for finished). The studied terminal tools (k9s, lazygit) use text and symbols; state needs words.
- Glass blur panels and frosted sidebars.
- Colour as the only state signal (lazygit's commit colours and k9s's skin colours). Substrate must add a text label to every state.

---

## Scale test

The three most promising patterns, from the fit list: **(A)** shelves by state with a filter bar (patterns 13 and 14, with 5), **(B)** a dense sortable table with facets and saved views (patterns 5 and 7), and **(C)** a card dashboard (pattern 6), included as the contrast the owner is most likely to propose.

Two cases: **Case 1** = 12 projects, 2 running. **Case 2** = 60 projects, 5 need a person, 8 untouched for months.

### (A) Shelves by state with a filter bar

- **Case 1, first second:** Shelves "Running (2)", "Needs you (0)", "Recent" and "Older (10)". The two running projects are at the top with elapsed time. The eye lands on the running shelf.
- **Case 1, find one project:** Type in the search box, or expand "Older". 12 rows fit without scroll.
- **Case 1, notice something needs you:** A "Needs you" shelf heading with a count; if zero it still shows, so absence is visible.
- **Case 2, first second:** "Needs you (5)" at the top, expanded, with the five rows; "Running (…)" below; "Older" collapsed with a count. The top of the page answers "what needs me" before any scroll.
- **Case 2, find one project:** Search box with fuzzy match; the list narrows as the user types. Facet "activity age: older than 3 months" shows the 8 untouched projects as one filtered list.
- **Case 2, notice something needs you:** The top shelf. The count changes the heading, not only a colour.

### (B) Dense sortable table with facets and saved views

- **Case 1, first second:** A table of 12 rows, sorted by the last activity, with a status column. The 2 running rows have text "running" and elapsed time. Sparse but clear.
- **Case 1, find one project:** `/` search or a click on a header to sort by name. Immediate.
- **Case 1, notice something needs you:** Only if a "Needs attention" column or a saved view exists; without it the user scans the status column. Acceptable at 12.
- **Case 2, first second:** 60 rows; the first rows are whatever the default sort gives. If the default sort is "needs attention first", the 5 needing a person are at the top. If not, they are hidden. The default sort matters more than the layout.
- **Case 2, find one project:** Fastest of the three: search, or a saved view "Needs me" pinned in the sidebar, which filters to the 5 in one click.
- **Case 2, notice something needs you:** A saved view with a count in its label; the status column also carries the text "needs you".

### (C) Card dashboard

- **Case 1, first second:** 12 cards in a grid. The 2 running cards can be marked with a text badge, but it is easy to miss among 12 equal cards. Good overview.
- **Case 1, find one project:** Visual scan of 12 cards; no sort or filter needed. Good.
- **Case 1, notice something needs you:** Only by the badge. Weak if the badge is small.
- **Case 2, first second:** 60 cards in a long scroll. The 5 needing a person are scattered unless sorted; the first screen shows roughly 6 to 9 cards. Poor.
- **Case 2, find one project:** Requires search. Works, but the card view is the wrong primary tool.
- **Case 2, notice something needs you:** Only if the cards are sorted or grouped; otherwise the owner scrolls. This is the failure the owner described.

**Result of the scale test:** (A) and (B) both pass Case 2. (C) fails it unless grouped by state, which turns it into (A) with cards.

---

## Recommendation

**Candidate 1: shelves by state with a filter bar (pattern 14, built from 13 and 5).**

- *Tile or row content:* one row per run: project name, run title (truncated), state label as text (`Needs you`, `Running`, `Paused`, `Failed`, `Finished`), elapsed or last-activity time, and cost. The shelf heading carries the count. No artwork.
- *Why:* it answers "what needs me" in the first second at 60 projects, keeps the Steam shelf idea the owner liked, and matches the RUNNING and PAST structure already agreed in `docs/design/web-ui.md`.

**Candidate 2: dense sortable table with facets and saved views (patterns 5 and 7).**

- *Row content:* one row per project, columns for state, needs-attention, last activity, cost and name. Sort by any column. A filter bar with facets from the vocabulary section. Saved views pinned in the sidebar and held in the URL hash.
- *Why:* best at 60 and above, cheapest to build, and keyboard-driven like the terminal tools the owner already uses. Weaker on glance-value at 12 because it looks sparse.

A tile row (pattern 3's "Continue" row) can sit above either candidate as a short "Needs you / Running / Recent" strip. That is a supplement, not a third candidate.

**Evidence that would change the ranking:**

- If the owner mainly wants to see **which project** at 12 projects with little text, the card dashboard (C) rises, and pattern 13 with cards is worth a prototype.
- If the owner rarely filters and mostly opens the same few projects, a recents-first tile row (Steam-like) may outrank the table.
- If the Steam FAQ or a live Steam client shows shelves and sorting behave as the snippets say, the Steam tile model gains some support, but Substrate's lack of artwork still limits it.
- If user testing shows colour-free state labels are too faint in the dense table (for example, the owner misses "Failed" rows), candidate 2 needs a stronger text treatment before it is chosen.
- If Plex or Jellyfin's continue rows are confirmed in a live product, the "Needs you" strip is better supported; the sources here were not readable.

Not decided here. The later design task chooses the layout.
