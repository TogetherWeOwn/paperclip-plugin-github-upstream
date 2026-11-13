import { describe, expect, it } from "vitest";
import { parseReviewTierMap } from "./review-tier-map-v1.js";

describe("isolated review tier map parser", () => {
  const valid = `version: 1 # schema
default_tier: sensitive # default
tiers:
  low: ["docs/**"]
  ordinary: ["src/ui/**"]
  sensitive: ["src/auth/**"]
`;
  it("parses v1 and unambiguous legacy maps", () => {
    expect(parseReviewTierMap(valid)).toEqual({ low: ["docs/**"], ordinary: ["src/ui/**"], sensitive: ["src/auth/**"] });
    expect(parseReviewTierMap('low: ["docs/**"]\n')).toEqual({ low: ["docs/**"], ordinary: [], sensitive: [] });
    expect(parseReviewTierMap('version: 1\ndefault_tier: sensitive\ntiers:\n  low: []\n  ordinary: []\n  sensitive: []\n').low).toEqual([]);
  });
  it("rejects incomplete, ambiguous and unsupported inputs", () => {
    for (const input of [
      valid.replace("version: 1 # schema", "version: 2"),
      valid.replace("version: 1 # schema", "version: 1#not-v1"),
      valid.replace("default_tier: sensitive # default", "default_tier: sensitive#x"),
      valid.replace("default_tier: sensitive # default\n", ""),
      valid.replace('"docs/**"', "1.5"),
      valid.replace('"docs/**"', "2026-11-11"),
      valid.replace('"docs/**"', "../escape"),
      valid + '  low: ["other/**"]\n',
    ]) expect(() => parseReviewTierMap(input)).toThrow();
    expect(parseReviewTierMap(valid.replace('"docs/**"', '"1.5"')).low).toEqual(["1.5"]);
  });

  it("parses versioned block lists and preserves quoted scalars and comments", () => {
    const input = `version: 1 # v1
    default_tier: sensitive
    tiers:
      low: # docs
        - docs/** # comment
        - "2026-11-11"
      ordinary:
        - src/ui/**
      sensitive:
        - 'src/auth/**'
    `.replace(/^    /gm, "");
    expect(parseReviewTierMap(input)).toEqual({ low: ["docs/**", "2026-11-11"], ordinary: ["src/ui/**"], sensitive: ["src/auth/**"] });
  });
  it("rejects duplicate v1 headers and absent tier lists", () => {
    for (const input of [
      valid + "version: 1\n",
      valid + "default_tier: sensitive\n",
      valid + "tiers:\n",
      valid.replace('  low: ["docs/**"]\n', ""),
      valid.replace('  ordinary: ["src/ui/**"]\n', ""),
      valid.replace('  sensitive: ["src/auth/**"]\n', ""),
      valid.replace('  low: ["docs/**"]', "  low:"),
    ]) expect(() => parseReviewTierMap(input)).toThrow();
  });
  it("rejects malformed lists and quotes in flow and block forms", () => {
    for (const value of ['["docs/**"', '["docs/**",]', '[, "docs/**"]', '[[docs/**]]', '["docs/**]', 'docs/**']) {
      expect(() => parseReviewTierMap(valid.replace('["docs/**"]', value))).toThrow();
    }
    for (const value of ['    - "docs/**', '    - [docs/**]', '   - docs/**']) {
      expect(() => parseReviewTierMap(valid.replace('  low: ["docs/**"]', '  low:\n' + value))).toThrow();
    }
  });
  it("rejects ambiguous unquoted scalars in flow and block forms", () => {
    for (const value of ["null", "true", "NO", "y", "0x10", "0o10", "0b10", ".inf", ".nan", "1e3", "2026-11-11"]) {
      expect(() => parseReviewTierMap(valid.replace('"docs/**"', value))).toThrow();
      expect(() => parseReviewTierMap(valid.replace('  low: ["docs/**"]', '  low:\n    - ' + value))).toThrow();
    }
    expect(parseReviewTierMap(valid.replace('"docs/**"', '"0x10"')).low).toEqual(["0x10"]);
  });
});
