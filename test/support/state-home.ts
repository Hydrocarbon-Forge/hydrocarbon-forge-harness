import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test process gets its own user state directory unless a test sets one. The project registry and the
// usage mirror live under XDG_STATE_HOME, so an in-process command run (init, run, plan, resume) never writes
// to the real home. Child processes inherit the variable.
if (!process.env.XDG_STATE_HOME) {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "substrate-test-state-"));
}
