import { posix, win32 } from "node:path";

export interface ReviewTierMap {
  low: string[];
  ordinary: string[];
  sensitive: string[];
}

export function parseReviewTierMap(text: string): ReviewTierMap {
  const map: ReviewTierMap = { low: [], ordinary: [], sensitive: [] };
  let current: keyof ReviewTierMap | null = null;
  let inlineList = false;
  let blockIndent: number | null = null;
  let inTiers = false;
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const versioned = lines.some((line) => /^version\s*:/.test(line));
  let versionSeen = false;
  let defaultSeen = false;
  let tiersSeen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripComment(lines[i] ?? "");
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (versioned && !raw.startsWith(" ") && !raw.startsWith("\t")) {
      if (current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
      current = null;
      inTiers = false;
      if (/^version:[ \t]+1\s*$/.test(raw) && !versionSeen) versionSeen = true;
      else if (/^default_tier:[ \t]+sensitive\s*$/.test(raw) && !defaultSeen) defaultSeen = true;
      else if (/^tiers:\s*$/.test(raw) && !tiersSeen) { tiersSeen = true; inTiers = true; }
      else throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
      continue;
    }
    // Tier keys are top-level in legacy maps, nested under tiers in v1.
    const tierLine = versioned ? (inTiers && /^  [^ ]/.test(raw) ? raw.slice(2) : null) : (!raw.startsWith(" ") && !raw.startsWith("\t") ? raw : null);
    if (tierLine !== null) {
      if (versioned && current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
      const keyMatch = /^([A-Za-z_-]+)\s*:(?:[ \t]+(.*))?$/.exec(tierLine);
      if (!keyMatch) throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
      const key = keyMatch[1] ?? "";
      if (key !== "low" && key !== "ordinary" && key !== "sensitive") {
        throw new Error(`invalid tier map: unknown key "${key}"`);
      }
      if (seen.has(key)) throw new Error(`invalid tier map: duplicate key "${key}"`);
      seen.add(key);
      current = key;
      blockIndent = null;
      const inline = (keyMatch[2] ?? "").trim();
      inlineList = inline !== "";
      if (inlineList) {
        for (const item of parseInlineList(inline)) map[key].push(validatePattern(item));
      }
      continue;
    }
    // Block list item under the current key.
    const itemMatch = /^( +)-\s+(.*)$/.exec(raw);
    const indent = itemMatch?.[1]?.length ?? 0;
    if (!itemMatch || current === null || inlineList || (versioned ? indent !== 4 : indent < 1) || (blockIndent !== null && blockIndent !== indent)) {
      throw new Error(`invalid tier map line ${i + 1}: ${JSON.stringify(raw)}`);
    }
    blockIndent = indent;
    map[current].push(validatePattern(dequote(itemMatch[2] ?? "")));
  }
  if (versioned && current && !inlineList && map[current].length === 0) throw new Error("invalid tier map: no patterns in block list");
  if (versioned && (!versionSeen || !defaultSeen || !tiersSeen || seen.size !== 3)) {
    throw new Error("invalid tier map: incomplete v1 schema");
  }
  const total = map.low.length + map.ordinary.length + map.sensitive.length;
  if (!versioned && total === 0) throw new Error("invalid tier map: no patterns");
  return map;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/** Split `["a", 'b', c]` (or a bare scalar) into de-quoted items. Throws on malformed flow. */
function parseInlineList(inline: string): string[] {
  if (!inline.startsWith("[")) {
    // A bare value after `key:` is not a list: fail closed rather than guess.
    throw new Error(`invalid tier map: expected a list for "${inline}"`);
  }
  if (!inline.endsWith("]")) throw new Error("invalid tier map: unterminated inline list");
  const inner = inline.slice(1, -1).trim();
  if (inner === "") return [];
  const items: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      items.push(dequote(buf));
      buf = "";
    } else if (ch === "[") {
      throw new Error("invalid tier map: nested inline list");
    } else {
      buf += ch;
    }
  }
  if (quote !== null) throw new Error("invalid tier map: unterminated quote");
  items.push(dequote(buf));
  return items;
}

function dequote(value: string): string {
  let v = value.trim();
  // Strip a trailing inline comment outside quotes ( "path # note").
  if (!v.startsWith('"') && !v.startsWith("'")) {
    const hash = v.indexOf(" #");
    if (hash !== -1) v = v.slice(0, hash).trim();
  }
  if (/^"[^"\\]*"$/.test(v) || /^'[^'\\]*'$/.test(v)) return v.slice(1, -1);
  // Accept only a deliberately small, unambiguous YAML plain-scalar subset.
  const yamlNumber = /^(?:0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?|\.[0-9_]+(?:e[-+]?[0-9]+)?|\.(?:inf|nan))$/i;
  const yamlDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_./*?-]*$/.test(v) || /^(null|true|false|y|n|yes|no|on|off|~)$/i.test(v) || yamlNumber.test(v) || yamlDate.test(v)) {
    throw new Error(`invalid tier map: ambiguous scalar ${JSON.stringify(value)}`);
  }
  return v;
}

/** A pattern is a repo-relative glob. Absolute paths, parents and backslashes never match — the map is invalid. */
function validatePattern(pattern: string): string {
  const normalized = pattern.replace(/^\.\//, "");
  if (normalized === "") throw new Error("invalid tier map: empty pattern");
  if (posix.isAbsolute(normalized) || win32.isAbsolute(normalized) || normalized.includes("..") || normalized.includes("\\")) {
    throw new Error(`invalid tier map: unsafe pattern ${JSON.stringify(pattern)}`);
  }
  if (normalized.length > 512) throw new Error(`invalid tier map: pattern too long: ${JSON.stringify(pattern).slice(0, 80)}`);
  return normalized;
}
