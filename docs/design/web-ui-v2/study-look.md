# Substrate web UI v2: look study

Status: investigation only. No UI code, no brand files copied into the repository. The brand files were read from `/home/bsmt-pc/HydrocarbonForge/Projects/hydrocarbon-forge-website/assets/`, the current stylesheet from `assets/web/app.css`, and the owner's website only for its `styles.css` and `index.html`, to list choices to avoid.

## Brand assets

### logo.png

- File: `assets/logo.png`, 1024 x 1024, 8-bit RGBA, non-interlaced. Every pixel is fully opaque (alpha 255), so there is no transparent version.
- Opened and viewed as an image. Layout: a white pointy-top hexagon ring with flat vertical sides, with a three-face cube in near-black inside it. Below it, the wordmark "HYDROCARBON" in tall, bold, condensed capitals, and "FORGE" beneath in the same family, much smaller and tracked wide, about a third of the width of the first line. The black field is the whole canvas.
- Measured with a stdlib PNG decoder (throwaway, not committed). Share of pixels by colour: `#000000` 92.0%, `#ffffff` 6.2%, `#0a0a0a` 0.3%, `#121212` 0.3%, `#1a1a1a` 0.3%. Nothing else exceeds 0.1%. The non-black bounding box is x 146 to 877 and y 262 to 710.
- Dominant colours: `#000000` (ground), `#ffffff` (ring and wordmark), with the cube in `#1a1a1a`, `#121212` and `#0a0a0a`.
- Shape language: hard straight edges, one hexagon, isometric cube, flat fills, no gradients, no shadows, no rounded corners apart from the ring's stroke caps in the SVG.

### favicon.svg

- File: `assets/favicon.svg`, 256 x 256 viewBox, exported from Inkscape. Read as text. Inkscape metadata is present and ignored.
- Structure: a full black rectangle `#000000`, a six-sided star path used as an outline hexagon with `stroke:#ffffff`, stroke width about 20 in local units, round caps, and `fill:none`. Inside it, three cube faces: top `#1a1a1a`, left `#121212`, right `#0a0a0a`, plus a duplicate `#121212` path offset slightly. No wordmark.
- Contrast within the mark: against its own `#000000` tile, the top face is 1.21 : 1, the left face 1.12 : 1 and the right face 1.06 : 1. The white ring is 21 : 1. At favicon sizes only the ring carries the mark; the cube reads only as a faint hint, and it is clearly visible only on a light surface.

### Reusable motifs

- Hexagon ring: an open outline hexagon is a good "project" tile glyph. It is the most distinctive shape in the assets and reads at 16 px.
- Cube: the three tones make a usable isometric glyph only when drawn as strokes or on a light tile. On a black tile, use the outline ring alone.
- Status candidates: the open ring can mean "not started" (planned). A solid three-face cube can mean "in progress" (running). These are suggestions for the design task, not decisions.

### What could not be determined

- The typeface name of the wordmark. It looks like a condensed grotesque, similar to the Oswald that the owner's site loads, but I did not verify a match. No font files are in the assets folder.
- Whether the wordmark is outlined text or live text. The PNG is flat, so this cannot be told.
- Any light-background variant of the logo. None exists in `assets/`. The white ring would vanish on a light page, so a light-theme mark needs the black tile or a dark-ink version that does not exist yet.
- Exact rendered favicon size behaviour. The SVG was read as text and not rasterised.

## Generic tells

Each row names the habit, the replacement rule that the implementation can follow, and the check a reviewer can run.

1. **Purple or blue-to-violet gradients on buttons, headers or hero.** Replace with: one flat fill per surface, taken from a token. Check: no `gradient(` in the stylesheet.
2. **Identical rounded cards with soft drop shadows in a grid.** Replace with: rows and panels separated by a 1 px border token and whitespace, no `box-shadow` on panels. Check: `box-shadow` appears only on the focus ring, and only if at all.
3. **Centred hero heading, subline and two call-to-action buttons.** Replace with: no marketing hero. The app opens on the job list and the selected job, with a left-aligned heading in the pane. Check: no `text-align: center` on the first screen.
4. **Emoji used as icons.** Replace with: status glyphs from the direction's table plus a text word, and no emoji anywhere. Check: no code point in the emoji ranges in `assets/web` or in rendered strings.
5. **Translucent blur panels (`backdrop-filter`).** Replace with: opaque surface tokens and a 1 px border. Check: no `backdrop-filter` and no `rgba(` surface colours.
6. **Uniform 12 px radius everywhere.** Replace with: radius tokens of 0 px for rows and tables, at most 3 px for controls, and nothing above 4 px. Check: no `border-radius` above 4 px.
7. **Grey-on-grey secondary text.** Replace with: the `muted` token must meet 4.5 : 1 on both `bg` and `surface`. Check: the contrast table in this study, rerun by the implementation's own test.
8. **Decorative glows, spotlights, grain overlays and cursor glow.** Replace with: flat backgrounds and no pseudo-element decoration. Check: no `radial-gradient`, no noise or grain image, no `::before` used for decoration.
9. **Stat-tile rows of large numbers with icons above the list.** Replace with: counts as inline text in section headings, tabular numerals. Check: no grid of big-number tiles.
10. **Rotating headline words, marquee tickers and scroll-reveal fades.** Replace with: no decorative motion at all. Check: no `@keyframes` except the running indicator's.
11. **Status shown by a coloured dot alone.** Replace with: every status is a glyph plus a word, as listed under each direction. Check: each state string in the UI has a non-colour label.
12. **Pill-shaped pastel badges on every label.** Replace with: plain text labels, with at most one filled element per row. Check: no `border-radius: 999px`.
13. **Hover lift (`translateY` with a glow shadow) on every card and button.** Replace with: hover changes background colour only. Check: no `transform` in `:hover` rules.
14. **Display face for headings with 28 px or larger size.** Replace with: headings at 17 px or smaller, separated by weight and spacing. Check: no font size above 20 px in the stylesheet.

## Directions

Every direction uses system font stacks only, with no CDN and no font download. Each has the same ten tokens for a dark and a light theme: `bg`, `surface`, `line`, `text`, `muted`, `accent`, `run`, `ok`, `warn`, `err`. The contrast values are in the matrix under "Contrast" below, and every required pair passes.

### A. Ledger

The idea: a bound working ledger, with warm paper, ruled rows and serif section heads. Brass marks the one thing that needs the user's attention or selection, and nothing else.

Palette (dark / light):

| Token | Dark | Light |
|---|---|---|
| bg | `#16181b` | `#f6f4ef` |
| surface | `#1e2125` | `#ffffff` |
| line | `#3a4048` | `#bdb8ad` |
| text | `#e8e6e1` | `#1d1f23` |
| muted | `#aab0b8` | `#50565f` |
| accent (brass) | `#e0b366` | `#7a5410` |
| run | `#7fc4f0` | `#0b5c8a` |
| ok | `#7fd3a0` | `#1c6b43` |
| warn | `#f0c25c` | `#7a5200` |
| err | `#ff9a8f` | `#9b1c1c` |

Type: headings in `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif` at 17 px, weight 600. Body in the system sans stack at 14 px, weight 400. Tabular numerals (`font-variant-numeric: tabular-nums`) in every count and table. Monospace stack `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace` at 12.5 px for IDs and paths only.

Spacing and borders: 4 px grid. Row height 32 px. Padding 8 px and 12 px. Rows are separated by 1 px `line`. Controls have a 1 px border in `muted`. Radius 0 for rows, 2 px for controls. No shadows.

Project tile:

```
+------------------------------------+
| [H] api-gateway                    |
|     2 running - 1 needs answers    |
+------------------------------------+
```

Status marker: `● running`

Motion: the running dot's opacity moves between 1 and 0.4 over 1.2 s. Nothing else moves. List order, positions and glyph shapes never move, and nothing eases in. Reduced motion: the dot stays at full opacity and does not move.

Hydrocarbon Forge mark: a 16 px outline hexagon before the word "Substrate" in the top bar, and the favicon. The word "Hydrocarbon Forge" appears only in the about line of the footer.

### B. Bench

The idea: a machine bench in graphite and white. Data and labels are set in monospace, prose in sans, and nothing is coloured unless it is a status. White is the only accent, taken directly from the mark's ring.

Palette (dark / light):

| Token | Dark | Light |
|---|---|---|
| bg | `#121212` | `#f2f2f2` |
| surface | `#1a1a1a` | `#ffffff` |
| line | `#3a3a3a` | `#b8b8b8` |
| text | `#ededed` | `#111111` |
| muted | `#a3a3a3` | `#4d4d4d` |
| accent (ring white) | `#ffffff` | `#111111` |
| run | `#8fd3ff` | `#005a8c` |
| ok | `#8bdc9e` | `#1b6b3a` |
| warn | `#f2c462` | `#7a4f00` |
| err | `#ff8a80` | `#a4161a` |

Type: monospace stack `ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` at 13 px for every label, count and row. Sans stack at 14 px for prose and the request text only. Tabular numerals are the default. Weights 400 and 600 only, with no italics.

Spacing and borders: 4 px grid, row height 28 px. 1 px `line` rules. Controls use a 1 px `muted` border. Radius 0 everywhere except 3 px on buttons. No shadows.

Project tile:

```
+--------------------------------+
| api-gateway                    |
| run 2   need 1   done 14       |
+--------------------------------+
```

Status marker: `> run`

Motion: the running marker is a four-frame text spinner `| / - \` stepped at 4 fps. Nothing else animates, and nothing eases. Reduced motion: the marker is the static `>` and the elapsed time updates once per second as text.

Hydrocarbon Forge mark: favicon only, and the about line in the footer. The mark does not appear in the top bar.

### C. Ember

The idea: a forge floor after the shift. Warm charcoal, one ember accent for primary actions and focus, and the hexagon used as the project tile glyph. Headings use a condensed stack that echoes the wordmark's capitals.

Palette (dark / light):

| Token | Dark | Light |
|---|---|---|
| bg | `#141210` | `#f7f3ee` |
| surface | `#1d1b19` | `#fffdfa` |
| line | `#3d3832` | `#cdbfb2` |
| text | `#efebe4` | `#231d18` |
| muted | `#b5ada2` | `#5c5047` |
| accent (ember) | `#ff7a3d` | `#b23a0a` |
| run | `#7ab8ff` | `#185a9d` |
| ok | `#8fd694` | `#2a6b2f` |
| warn | `#ffc857` | `#7a4c00` |
| err | `#ff7b72` | `#a11d1d` |

Type: headings in `"Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", "Helvetica Neue", sans-serif` at 16 px, weight 600, uppercase at 0.04 em tracking. Body in the system sans stack at 14 px. Monospace for IDs. Tabular numerals in counts only.

Spacing and borders: 4 px grid, row height 32 px. 1 px `line` borders. Controls use a 1 px `muted` border. Radius 2 px. No shadows.

Project tile:

```
    _____
   /     \    api-gateway
   \_____/    2 running - 1 needs answers
```

Status marker: `◆ running`

Motion: the running hexagon's fill moves between two ember shades over 2 s. Nothing else moves. Reduced motion: the fill is static. Layout never moves.

Hydrocarbon Forge mark: the hexagon is the default project tile glyph, drawn in `muted`. The full mark appears at 16 px in the top bar after the word "Substrate", and as the favicon.

### D. Plate

The idea: a calibrated bench sheet. Cool neutral surfaces, grid-led tables with hairline rules, and status written as a bracketed word so it can be read without colour. Nothing animates, and the accent is used only for focus and selection.

Palette (dark / light):

| Token | Dark | Light |
|---|---|---|
| bg | `#101418` | `#eef2f6` |
| surface | `#171c22` | `#ffffff` |
| line | `#303a46` | `#aeb9c6` |
| text | `#e2e8f0` | `#111827` |
| muted | `#9aa6b5` | `#4b5563` |
| accent | `#6cb2ff` | `#1a56a8` |
| run | `#6cc8f0` | `#0c5a80` |
| ok | `#6fd38f` | `#1d6a3f` |
| warn | `#ebc35e` | `#78500a` |
| err | `#ff8e8e` | `#a3201f` |

Type: system sans stack at 14 px for everything. Tabular numerals on every number column, with numbers right-aligned. Monospace only for IDs and paths. Weights 400 and 600.

Spacing and borders: 4 px grid, row height 30 px. Hairline grid of 1 px `line`. Controls use a 1 px `muted` border. Radius 0 for rows and 2 px for controls. No shadows.

Project tile:

```
+------------------------------------+
| api-gateway                 [run]  |
| 2 running   1 needs answers        |
+------------------------------------+
```

Status marker: `[run]`

Motion: none. The running elapsed time updates once per second as text. Reduced motion needs no change, because nothing moves.

Hydrocarbon Forge mark: favicon and the about line in the footer only. The top bar carries the word "Substrate" alone.

### Status glyphs per direction

Every state has a glyph and a word, so no state depends on colour. The word is always shown.

| State | A Ledger | B Bench | C Ember | D Plate |
|---|---|---|---|---|
| running | `●` running | `>` run | `◆` running | `[run]` |
| planned | `○` planned | `.` plan | `◇` planned | `[plan]` |
| paused (needs answers) | `?` needs answers | `?` need | `?` needs answers | `[ask]` |
| paused (stopped) | `‖` paused | `\|\|` paused | `‖` paused | `[hold]` |
| failed | `✕` failed | `x` fail | `▲` failed | `[fail]` |
| finished | `✓` finished | `+` done | `✔` finished | `[done]` |
| stopped | `■` stopped | `#` stop | `■` stopped | `[stop]` |
| cancelled | `⊘` cancelled | `-` cancelled | `×` cancelled | `[cxl]` |

Direction B is ASCII only, so it works in any terminal font. The other three use single symbols from common glyph ranges, and each has a word beside it. Glyphs within each column are distinct.

### Contrast

Computed with a throwaway Node script (`/tmp/st2-study/contrast.js`, not committed). The formula is the WCAG 2.x relative-luminance ratio, and the thresholds are 4.5 : 1 for text and 3 : 1 for non-text marks. All required pairs pass in every theme of every direction. The full set of 144 rows was checked; the matrix below is the compact form.

| Pair (required) | A Ledger dark | A Ledger light | B Bench dark | B Bench light | C Ember dark | C Ember light | D Plate dark | D Plate light |
|---|---|---|---|---|---|---|---|---|
| body text on bg (4.5) | 14.26 | 15.01 | 16.00 | 16.87 | 15.73 | 15.08 | 15.00 | 15.77 |
| body text on surface (4.5) | 12.96 | 16.50 | 14.87 | 18.88 | 14.45 | 16.41 | 13.90 | 17.74 |
| muted text on bg (4.5) | 8.14 | 6.73 | 7.43 | 7.55 | 8.42 | 7.06 | 7.48 | 6.72 |
| muted text on surface (4.5) | 7.40 | 7.40 | 6.90 | 8.45 | 7.74 | 7.68 | 6.93 | 7.56 |
| accent link text on bg (4.5) | 9.16 | 6.16 | 18.73 | 16.87 | 7.21 | 5.43 | 8.32 | 6.35 |
| bg-coloured label on accent fill (4.5) | 9.16 | 6.16 | 18.73 | 16.87 | 7.21 | 5.43 | 8.32 | 6.35 |
| running on bg (4.5) | 9.37 | 6.56 | 11.53 | 6.60 | 9.01 | 6.36 | 9.83 | 6.69 |
| running on surface (4.5) | 8.51 | 7.21 | 10.72 | 7.39 | 8.28 | 6.92 | 9.10 | 7.53 |
| finished (ok) on bg (4.5) | 9.93 | 5.91 | 11.44 | 5.84 | 10.87 | 5.86 | 10.03 | 5.86 |
| finished (ok) on surface (4.5) | 9.03 | 6.49 | 10.63 | 6.54 | 9.99 | 6.38 | 9.29 | 6.59 |
| needs answers (warn) on bg (4.5) | 10.65 | 6.30 | 11.46 | 6.37 | 12.15 | 6.64 | 11.01 | 6.33 |
| needs answers (warn) on surface (4.5) | 9.68 | 6.92 | 10.65 | 7.13 | 11.16 | 7.23 | 10.20 | 7.12 |
| failed (err) on bg (4.5) | 8.70 | 7.41 | 8.21 | 6.93 | 7.41 | 7.02 | 8.38 | 6.71 |
| failed (err) on surface (4.5) | 7.90 | 8.15 | 7.62 | 7.75 | 6.81 | 7.64 | 7.76 | 7.54 |
| muted glyph on bg, planned / paused / cancelled (3.0) | 8.14 | 6.73 | 7.43 | 7.55 | 8.42 | 7.06 | 7.48 | 6.72 |
| focus ring (accent) on bg (3.0) | 9.16 | 6.16 | 18.73 | 16.87 | 7.21 | 5.43 | 8.32 | 6.35 |
| focus ring (accent) on surface (3.0) | 8.32 | 6.77 | 17.40 | 18.88 | 6.63 | 5.90 | 7.71 | 7.14 |
| line on bg, decorative only (info) | 1.70 | 1.80 | 1.65 | 1.77 | 1.61 | 1.63 | 1.60 | 1.77 |

Result: no required pair fails. The `line` token is 1.6 to 1.8 : 1 against `bg`, so it is decorative only, and it is never the sole boundary of a control or the sole indicator of a state. Control edges use the `muted` token, which is above 3 : 1 on both `bg` and `surface` in all eight themes. Status glyphs are never drawn in `line`.

## Recommendation

Ranking for a functional tool that is read all day, best first:

1. **D Plate.** Neutral surfaces and the lowest accent load, so a long session does not fatigue the eye. Tabular numbers and right-aligned columns make the counts scannable. Its status tags are plain words, so nothing depends on colour, and the system stacks keep it fast to load. It has the least brand presence.
2. **A Ledger.** Warm paper in light mode and a muted brass accent are easy on the eye for long reading. The serif headings separate sections without decoration. Its only cost is that the serif heading stack varies by platform, so the look is less uniform than D.
3. **B Bench.** Its monospace-first layout is precise, and the white accent reads well. Pure `#121212` with near-white text is high contrast (about 16 : 1), which many people find harsh over a full working day. It is also the most like a terminal, which the owner may not want.
4. **C Ember.** The most distinctive and the most brand-led, but the ember accent is the most saturated colour in the set, and it competes with the status colours for attention all day. Its condensed headings also depend on fonts that may be missing on Linux.

The single element that would change the ranking if the owner wants more brand presence: whether the accent colour may appear in chrome (the top bar, the tile edge and the selection bar), or only in focus and primary actions. If chrome may carry the accent, C Ember moves up to second, because the hexagon glyph and ember accent then carry the brand without changing any status meaning. Nothing else in the ranking needs to change.

The website's look is avoided in all four. The website's `styles.css` loads Oswald, Inter and JetBrains Mono from Google Fonts, and uses a grain overlay, a cursor glow, a hex-grid hero, a rotating headline, a marquee, scroll-reveal fades, glow shadows, a `backdrop-filter` blur and hover lifts. None of these appears in any direction above.
