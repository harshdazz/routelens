// Paths into a response, used by checks and `extract` (ADR-0008):
//   status · statusText · durationMs · headers.content-type · body · body.items[0].id
//   body.items.length · body["odd key"]

/** One step of a value path: a property name or an array index. */
export type PathSegment = string | number;

/** The parts of a response a path can start from. */
export const PATH_ROOTS = ["status", "statusText", "durationMs", "headers", "body"] as const;

const NAME = /[^.[\]]+/y;
const INDEX = /\[(\d+)\]/y;
const QUOTED = /\[("(?:[^"\\]|\\.)*")\]/y;

/** Split a path into its segments, or `undefined` when it is not a valid path. */
export function parseValuePath(text: string): PathSegment[] | undefined {
  const segments: PathSegment[] = [];
  let at = 0;
  const read = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (match) at = pattern.lastIndex;
    return match;
  };

  const first = read(NAME);
  if (!first) return undefined;
  segments.push(first[0]);
  while (at < text.length) {
    if (text[at] === ".") {
      at += 1;
      const name = read(NAME);
      if (!name) return undefined;
      segments.push(name[0]);
      continue;
    }
    const index = read(INDEX);
    if (index) {
      segments.push(Number(index[1]));
      continue;
    }
    const quoted = read(QUOTED);
    if (!quoted?.[1]) return undefined;
    segments.push(JSON.parse(quoted[1]) as string);
  }
  return segments;
}

/** True when `text` is a path that starts at a part of the response (`body.id`, not `id`). */
export function isResponsePath(text: string): boolean {
  const first = parseValuePath(text)?.[0];
  return typeof first === "string" && (PATH_ROOTS as readonly string[]).includes(first);
}

/**
 * The value at `path` inside `subject`. `found` is false when a part of the path is missing.
 * Header names are matched in lower case; `length` works on arrays and strings.
 */
export function readValuePath(
  subject: Readonly<Record<string, unknown>>,
  path: string,
): { found: boolean; value: unknown } {
  const segments = parseValuePath(path);
  if (!segments) return { found: false, value: undefined };
  let current: unknown = subject;
  for (const [position, raw] of segments.entries()) {
    const segment =
      position === 1 && segments[0] === "headers" && typeof raw === "string"
        ? raw.toLowerCase()
        : raw;
    const next = step(current, segment);
    if (!next.found) return next;
    current = next.value;
  }
  return { found: true, value: current };
}

function step(current: unknown, segment: PathSegment): { found: boolean; value: unknown } {
  if (Array.isArray(current)) {
    const index = typeof segment === "number" ? segment : /^\d+$/.test(segment) ? +segment : NaN;
    if (Number.isInteger(index)) {
      return index < current.length
        ? { found: true, value: current[index] }
        : { found: false, value: undefined };
    }
    return segment === "length"
      ? { found: true, value: current.length }
      : { found: false, value: undefined };
  }
  if (typeof current === "string") {
    return segment === "length"
      ? { found: true, value: current.length }
      : { found: false, value: undefined };
  }
  if (current !== null && typeof current === "object") {
    const key = String(segment);
    return Object.hasOwn(current, key)
      ? { found: true, value: (current as Record<string, unknown>)[key] }
      : { found: false, value: undefined };
  }
  return { found: false, value: undefined };
}
