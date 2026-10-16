import { createHash } from "crypto";

export function canonicalize(obj: unknown): string {
  const ancestors = new Set<object>();
  const visit = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return JSON.stringify(value);
    }
    if (typeof value !== "object" || value === null) {
      throw new Error("Canonical JSON requires JSON-compatible values");
    }
    if (ancestors.has(value)) {
      throw new Error("Canonical JSON cannot contain cycles");
    }
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error("Canonical JSON requires plain objects");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return "[" + Array.from(value, (item) => visit(item)).join(",") + "]";
      }
      const record = value as Record<string, unknown>;
      return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + visit(record[key])).join(",") + "}";
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(obj);
}

export function computeCanonicalSha256(payload: unknown): string {
  const canonicalString = canonicalize(payload);
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}
