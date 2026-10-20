# Decisions

Request was just "make a snake game" on an empty repository. Assumption: a browser game in plain ES modules with no dependencies, because it needs no `npm ci`, no network and no build. Node 26, npm and python3 are available on the host. Tests use the built-in `node --test`. `package.json` and the two stubs (`src/game.js`, `src/controls.js`) are committed as contracts before any worker starts.

## T1 (tests)
Class is `feature` because `tests` is not configured in the routing settings; it still only writes test files. T2 and T3 depend on it, so the protected test files stay legal.
Boundary: one tests task owns all four test files so the semantics of game, controls and DOM wiring are written once, by one author, and cannot drift. This is also the riskiest task, because the spec dictates the fake-DOM harness that fixes the shape of `main.js`; it runs first so a mismatch is cheap to find. Most likely to go wrong: a test file that parses but encodes a wrong expectation (the hand-made collision states, the clock-tick counts in the game-over case), which later makes T2 or T3 unfixable. Its verify can only check that the files parse, since the stubs throw.
If it fails: the usual cause is `node --check` rejecting a syntax error; fix that and rerun. If a later task cannot pass a protected test, replan T1 with the corrected expectation, do not let the implementer edit it.

## T2 (game logic)
Boundary: pure rules in `src/game.js` with an injectable `rng`, so everything is deterministic and gated by `node --test test/game.test.js`. Kept separate from T3 because T3's main.test.js needs the real implementation, so T3 depends on T2 and the two run in sequence; the write sets are disjoint anyway. Most likely to go wrong: the vacating-tail rule and the `direction` versus `nextDirection` reversal check.
If it fails: compare the failing assertion with spec Behavior 4 and 8; the tail exclusion applies only when no food is eaten. If a test itself contradicts the T1 spec, replan T1.

## T3 (UI, controls, docs)
Boundary: key mapping, `main.js`, page, CSS and README form one cohesive slice of roughly 250 lines, so they stay together instead of one task per file. Verified by controls, fake-DOM and structure tests plus `node --check`; real browser rendering is not verified by any command. Most likely to go wrong: using a global the fake DOM lacks (such as `window` or `requestAnimationFrame`), or leaving two timers pending after restart.
If it fails: run `node --test test/main.test.js` and read the first thrown error; it is almost always an undeclared global at load or a wrong message string. `README.md` is the only safely skippable output.

## Integration
`integration_verify` runs `npm test` only once `src/main.js` exists. After the first batch (T1 alone) the suite is red by design, because the stubs throw, so the command is guarded on that file rather than running a known failure.

## Contract typecheck
The typecheck commands skip a stub when it is not present in the working directory (guarded with `existsSync`) because the engine ran them at the repository root before the stubs were committed; with the stubs present they import each module and assert every export is a function.
