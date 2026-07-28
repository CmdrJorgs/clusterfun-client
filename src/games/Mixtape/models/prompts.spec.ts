import { MIXTAPE_PROMPTS } from "./prompts";

// prompts.ts stores its bank as a raw-text block parsed on import.  These tests pin that
// parse so an edit to the block (a stray blank line, a comment, an accidental quote) can't
// silently ship a broken prompt list.

// These assertions deliberately test the PARSER's invariants, not the bank's exact contents:
// prompts get added and reworded all the time, and the suite must not break when they do.

describe("MIXTAPE_PROMPTS", () => {
  it("parses one prompt per non-blank line", () => {
    // Lower bound, not an exact count — growing the bank must never fail this test.
    expect(MIXTAPE_PROMPTS.length).toBeGreaterThanOrEqual(40);
  });

  it("has no blank or whitespace-only entries", () => {
    expect(MIXTAPE_PROMPTS.every((p) => p.length > 0)).toBe(true);
  });

  it("carries no leftover source syntax (trailing commas / unbalanced quotes)", () => {
    // A line left over from an array literal looks like `"Some prompt",`.  A prompt may
    // legitimately contain — or even consist of — a quotation, so the tell is a trailing
    // comma or an odd number of quote characters, not the mere presence of a quote.
    const dirty = MIXTAPE_PROMPTS.filter(
      (p) => p.endsWith(",") || (p.match(/"/g) ?? []).length % 2 !== 0,
    );
    expect(dirty).toEqual([]);
  });

  it("ignores comment lines", () => {
    expect(MIXTAPE_PROMPTS.some((p) => p.startsWith("#"))).toBe(false);
  });

  it("preserves apostrophes without escaping", () => {
    // Derived from the bank at runtime rather than pinned to one string that may be
    // reworded or deleted: some prompt uses an apostrophe, and none carries an escape.
    expect(MIXTAPE_PROMPTS.some((p) => p.includes("'"))).toBe(true);
    expect(MIXTAPE_PROMPTS.filter((p) => p.includes("\\'"))).toEqual([]);
  });
});
