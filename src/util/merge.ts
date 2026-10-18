function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function cloneDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = cloneDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Deeply merges `overlay` into `base` without mutating arguments.
 * - Plain objects merge recursively.
 * - Arrays and primitives in `overlay` replace the base value.
 * - `undefined` in `overlay` is ignored (preserves base value).
 * - `null` in `overlay` replaces the base value.
 */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined) {
    return cloneDeep(base);
  }
  if (base === undefined) {
    return cloneDeep(overlay as unknown as T);
  }
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return cloneDeep(overlay as unknown as T);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(base)) {
    result[key] = cloneDeep(val);
  }

  for (const [key, val] of Object.entries(overlay)) {
    if (val === undefined) {
      continue;
    }
    if (key in result) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = cloneDeep(val);
    }
  }

  return result as unknown as T;
}
