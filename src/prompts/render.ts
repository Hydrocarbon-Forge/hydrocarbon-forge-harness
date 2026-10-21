const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

function substitute(value: string): string {
  return value.trim() === "" ? "(none)" : value;
}

/**
 * Replace every `{{name}}` (name: `[a-z_]+`) with `vars[name]`.
 * An empty or whitespace-only value renders as `(none)`.
 * Throws if the template uses a name the caller did not pass, or if the template itself
 * holds a `{{` that is not a placeholder. Values are data: a value may contain `{{`
 * (a contract stub with a JSDoc type such as `{{ x: number }}` does), and it is inserted as is (R9.1).
 */
export function render(template: string, vars: Record<string, string>): string {
  const out = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`missing template variable: ${name}`);
    }
    return substitute(vars[name]);
  });

  // The check reads the template, not the output: `out` carries the values as well.
  if (template.replace(PLACEHOLDER, "").includes("{{")) {
    throw new Error("unrendered placeholder in template");
  }

  return out;
}
