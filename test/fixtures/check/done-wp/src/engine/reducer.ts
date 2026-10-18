export function reduce(state: unknown, event: { type: string }) {
  switch (event.type) {
    case "bad.consumed":
      return state;
    default:
      return state;
  }
}
