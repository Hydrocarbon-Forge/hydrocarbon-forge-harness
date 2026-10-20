// `typeof Kept` names the value binding, so Kept is live.
export const Kept = { kind: "kept" } as const;
export type Kept = typeof Kept;

// Seeded true positive: no value or type-query reference.
export const Unused = { kind: "unused" } as const;

// A type-only reference must NOT keep a class alive.
export class TypeOnly {}
export function takesTypeOnly(x: TypeOnly): TypeOnly {
  return x;
}
