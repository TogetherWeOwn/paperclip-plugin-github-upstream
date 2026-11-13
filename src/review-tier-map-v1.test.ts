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
  it("accepts empty legacy block tiers only when another tier has patterns", () => {
    const expected = { low: [], ordinary: ["src/**"], sensitive: [] };
    expect(parseReviewTierMap('low:\nordinary: ["src/**"]\nsensitive: []\n')).toEqual(expected);
    expect(parseReviewTierMap('ordinary: ["src/**"]\nlow:\n')).toEqual(expected);
    expect(() => parseReviewTierMap('low:\nordinary: []\nsensitive:\n')).toThrow();
    expect(() => parseReviewTierMap(valid.replace('  sensitive: ["src/auth/**"]', '  sensitive:'))).toThrow();
  });
  it("preserves spaces in quoted patterns and rejects missing mapping separation", () => {
    expect(parseReviewTierMap(valid.replace('"docs/**"', '" docs/** "')).low).toEqual([" docs/** "]);
    expect(parseReviewTierMap(valid.replace('  low: ["docs/**"]', "  low:\n    - ' docs/** '")).low).toEqual([" docs/** "]);
    for (const input of [
      valid.replace("version: 1", "version:1"),
      valid.replace("default_tier: sensitive", "default_tier:sensitive"),
      valid.replace('low: ["docs/**"]', 'low:["docs/**"]'),
    ]) expect(() => parseReviewTierMap(input)).toThrow();
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
      valid.replace('"docs/**"', '"C:/private/**"'),
      valid.replace('"docs/**"', '"/private/**"'),
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
  it("recognizes only space and tab as comment separators", () => {
    for (const separator of [" ", "\t"]) {
      const item = `docs/**${separator}# comment`;
      expect(parseReviewTierMap(valid.replace('  low: ["docs/**"]', `  low:\n    - ${item}`)).low).toEqual(["docs/**"]);
      expect(parseReviewTierMap(`low:\n  - ${item}\n`).low).toEqual(["docs/**"]);
    }
    const literal = "docs/** #literal";
    expect(() => parseReviewTierMap(valid.replace('  low: ["docs/**"]', `  low:\n    - ${literal}`))).toThrow();
    expect(() => parseReviewTierMap(`low:\n  - ${literal}\n`)).toThrow();
    expect(parseReviewTierMap(valid.replace('  low: ["docs/**"]', `  low:\n    - "${literal}" # comment`)).low).toEqual([literal]);
    expect(parseReviewTierMap(`low:\n  - '${literal}'\t# comment\n`).low).toEqual([literal]);
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
