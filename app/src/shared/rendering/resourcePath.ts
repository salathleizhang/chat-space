/** Keep a repaired file's loader identity distinct from the previous generation. */
export function resourcePath(path: string, revision = 0) {
  return `${path}${path.includes("?") ? "&" : "?"}revision=${revision}`;
}
