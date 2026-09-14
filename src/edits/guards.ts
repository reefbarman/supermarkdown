import { hashSource } from "../engine/sourceIndex";

export function sourceMatchesHash(
  source: string,
  expectedHash: string,
): boolean {
  return hashSource(source) === expectedHash;
}

export function normalizeBlockReplacement(
  original: string,
  replacement: string,
): string {
  const ending = original.endsWith("\r\n")
    ? "\r\n"
    : original.endsWith("\n")
      ? "\n"
      : "";
  if (!ending) {
    return replacement.replace(/\r?\n$/u, "");
  }
  return replacement.replace(/\r?\n$/u, "") + ending;
}

export function validTaskMarker(marker: string, expectedHash: string): boolean {
  return /^\[[ xX]\]$/u.test(marker) && sourceMatchesHash(marker, expectedHash);
}
