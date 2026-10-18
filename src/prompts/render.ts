const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

function substitute(value: string): string {
  return value.trim() === "" ? "(none)" : value;
}

/**
 * Replace every `{{name}}` (name: `[a-z_]+`) with `vars[name]`.
 * An empty or whitespace-only value renders as `(none)`.
 * Throws if the template uses a name the caller did not pass,
 * or if any `{{` survives substitution.
 */
export function render(template: string, vars: Record<string, string>): string {
  const out = template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`missing template variable: ${name}`);
    }
    return substitute(vars[name]);
  });

  if (out.includes("{{")) {
    throw new Error("unrendered placeholder in template");
  }

  return out;
}
