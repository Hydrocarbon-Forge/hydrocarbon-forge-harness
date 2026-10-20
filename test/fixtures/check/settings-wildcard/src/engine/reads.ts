// Reads through values taken from wildcard records: the leaf is a property of a
// variable, not of a literal settings path.
export function inputRate(settings: any, id: string): number {
  const rates = settings.pricing.models[id];
  return rates.input_per_mtok;
}

export function routeModel(settings: any, cls: string): string {
  const route = settings.routing[cls];
  return route.model;
}
