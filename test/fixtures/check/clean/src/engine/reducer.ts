export function reduce(state: unknown, event: { type: string }) {
  switch (event.type) {
    case "task.started":
      return state;
    default:
      return state;
  }
}
