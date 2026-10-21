import { describe, expect, it } from "vitest";

import {
  INTEGRATION_COMMAND_MAX,
  INTEGRATION_LINE_MAX,
  INTEGRATION_TAIL_MAX_BYTES,
  integrationFailureDetail,
} from "../../../src/engine/actions/shared.js";

const ROOT = "/work/checkout";
const WORKTREE = `${ROOT}/.substrate/worktrees/r_X/integration`;

describe("R7.11: what an integration failure says", () => {
  it("names the command and exit code, and quotes the last non-empty output line", () => {
    const detail = integrationFailureDetail(
      {
        command: "npm test",
        exit_code: 1,
        timed_out: false,
        output: "ok 1\n  AssertionError: expected 2 to be 3\n\n",
      },
      [WORKTREE, ROOT]
    );
    expect(detail).toEqual({
      command: "npm test",
      exit_code: 1,
      output_tail: "ok 1\n  AssertionError: expected 2 to be 3\n\n",
      message: "npm test exited 1: AssertionError: expected 2 to be 3",
    });
  });

  it("reports a timed out command with no exit code", () => {
    const detail = integrationFailureDetail(
      { command: "sleep 999", exit_code: null, timed_out: true, output: "" },
      [WORKTREE, ROOT]
    );
    expect(detail.exit_code).toBeNull();
    expect(detail.message).toBe("sleep 999 timed out");
  });

  it("omits the output part when the command printed nothing", () => {
    const detail = integrationFailureDetail(
      { command: "test -f src/never.txt", exit_code: 1, timed_out: false, output: "" },
      [WORKTREE, ROOT]
    );
    expect(detail.message).toBe("test -f src/never.txt exited 1");
    expect(detail.output_tail).toBe("");
  });

  it("redacts secrets and takes the worktree and repository paths out of the text", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const detail = integrationFailureDetail(
      {
        command: `node check.js ${WORKTREE}/src/x.js`,
        exit_code: 2,
        timed_out: false,
        output: `Error at ${WORKTREE}/src/x.js with ${token}\nat ${ROOT}/lib/y.js:3`,
      },
      [WORKTREE, ROOT]
    );
    expect(detail.command).not.toContain(ROOT);
    expect(detail.output_tail).not.toContain(ROOT);
    expect(detail.output_tail).not.toContain(token);
    expect(detail.output_tail).toContain("[REDACTED]");
    expect(detail.message).toContain("node check.js src/x.js exited 2: ");
  });

  it("caps the command, the output tail and the quoted line", () => {
    const long = "x".repeat(INTEGRATION_TAIL_MAX_BYTES * 2);
    const detail = integrationFailureDetail(
      { command: `echo ${"c".repeat(INTEGRATION_COMMAND_MAX + 50)}`, exit_code: 1, timed_out: false, output: `head\n${long}` },
      [WORKTREE, ROOT]
    );
    expect(detail.command.length).toBe(INTEGRATION_COMMAND_MAX);
    expect(Buffer.byteLength(detail.output_tail, "utf8")).toBeLessThanOrEqual(INTEGRATION_TAIL_MAX_BYTES);
    const quoted = detail.message.slice(detail.message.indexOf(": ") + 2);
    expect(quoted.length).toBeLessThanOrEqual(INTEGRATION_LINE_MAX);
  });
});
