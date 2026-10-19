export function autoMerge(settings: { git: { auto_merge: boolean } }): boolean {
  return settings.git.auto_merge;
}
