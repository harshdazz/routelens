/** Matches `{{name}}` and `{{ name }}`. Names: letters, digits, `_`, `.`, `-`. */
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

export type Variables = Readonly<Record<string, string>>;

export interface InterpolationResult {
  value: string;
  /** Variable names used in the template but not defined. Unique, in order of appearance. */
  missing: string[];
}

/**
 * Replace `{{name}}` with its value. Unknown variables are left as they are
 * (so the user can see them) and reported in `missing`.
 */
export function interpolate(template: string, variables: Variables): InterpolationResult {
  const missing: string[] = [];
  const value = template.replace(VARIABLE_PATTERN, (match, name: string) => {
    if (Object.hasOwn(variables, name)) {
      return variables[name] as string;
    }
    if (!missing.includes(name)) {
      missing.push(name);
    }
    return match;
  });
  return { value, missing };
}

/** All variable names used in a template, unique, in order of appearance. */
export function findVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] as string;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
