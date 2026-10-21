import { describe, expect, it } from "vitest";

import { withRepoLock } from "../../../src/git/repo-lock.js";

// R8.3: operations that change a repository's shared metadata queue on one lock per repository.

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withRepoLock", () => {
  it("runs operations on one repository one after another, in call order", async () => {
    const log: string[] = [];
    const gate = deferred();
    const first = withRepoLock("/repo", async () => {
      log.push("first start");
      await gate.promise;
      log.push("first end");
      return 1;
    });
    const second = withRepoLock("/repo", () => {
      log.push("second");
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log).toEqual(["first start"]);
    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(["first start", "first end", "second"]);
  });

  it("does not make operations on different repositories wait for each other", async () => {
    const gate = deferred();
    const blocked = withRepoLock("/repo-a", () => gate.promise);
    const other = await withRepoLock("/repo-b", () => "free");
    expect(other).toBe("free");
    gate.resolve();
    await blocked;
  });

  it("a failing operation rejects its own call and does not block the operations queued after it", async () => {
    const failing = withRepoLock("/repo-c", () => {
      throw new Error("git failed");
    });
    const after = withRepoLock("/repo-c", () => "next");
    await expect(failing).rejects.toThrow("git failed");
    expect(await after).toBe("next");
  });

  it("releases the repository once the queue is empty, so a later call is not left waiting", async () => {
    await withRepoLock("/repo-d", () => undefined);
    await withRepoLock("/repo-d", () => undefined);
    expect(await withRepoLock("/repo-d", () => 3)).toBe(3);
  });
});
