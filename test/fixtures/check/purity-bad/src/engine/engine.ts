import "../../test/conformance.js";

declare const FakeAdapter: any;
declare const id: any;

export function bad() {
  console.log("bad");
  const s = new Error().stack;
  const v = process.env.VITEST;
  const m = "First attempt done";
  const p = "You are the Substrate something";
  const code = "export const val_${id} = 1;";
  const f = FakeAdapter;
  const ip = "192.168.1.1";
}
