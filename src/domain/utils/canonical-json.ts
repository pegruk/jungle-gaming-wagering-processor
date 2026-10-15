import { createHash } from "crypto";

export function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalize(item)).join(",") + "]";
  }
  // Ordena as chaves alfabeticamente de forma determinística
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((key) => {
    return JSON.stringify(key) + ":" + canonicalize((obj as Record<string, unknown>)[key]);
  });
  return "{" + entries.join(",") + "}";
}

export function computeCanonicalSha256(payload: unknown): string {
  const canonicalString = canonicalize(payload);
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}
