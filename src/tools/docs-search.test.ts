import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excerptAround, scoreSection, searchDocs, splitSections } from "./docs-search.js";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function corpus(files: Record<string, string>): { label: string; dir: string }[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-docs-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return [{ label: "test", dir }];
}

describe("splitSections", () => {
  it("gives each section its nearest heading and 1-based line", () => {
    const md = "# Top\n\nintro\n\n## Second\n\nbody\n";
    const s = splitSections(md, "f.md");
    expect(s.map((x) => x.heading)).toEqual(["Top", "Second"]);
    expect(s[1].text).toContain("body");
    expect(s[1].line).toBe(5);
  });

  it("does not treat a shell comment in a code fence as a heading", () => {
    const md = "# Real\n\n```bash\n# not a heading\nidf.py build\n```\n\nafter\n";
    const s = splitSections(md, "f.md");
    expect(s).toHaveLength(1);
    expect(s[0].heading).toBe("Real");
    expect(s[0].text).toContain("idf.py build");
  });

  it("labels leading prose with the file name when there is no heading yet", () => {
    const s = splitSections("no heading here\n", "guide.md");
    expect(s[0].heading).toBe("guide.md");
  });
});

describe("scoreSection", () => {
  const sec = (heading: string, text: string) => ({ file: "f.md", heading, line: 1, text });

  it("ranks a heading match above a body match", () => {
    const inHeading = scoreSection(sec("Kit loading", "unrelated prose"), ["kit"]);
    const inBody = scoreSection(sec("Something else", "the kit is loaded"), ["kit"]);
    expect(inHeading).toBeGreaterThan(inBody);
  });

  it("ranks a section with every term above one that repeats a single term", () => {
    const all = scoreSection(sec("x", "the kit load is async"), ["kit", "load", "async"]);
    const repeated = scoreSection(sec("x", "kit kit kit kit kit kit kit kit"), ["kit", "load", "async"]);
    expect(all).toBeGreaterThan(repeated);
  });

  it("scores nothing when no term appears", () => {
    expect(scoreSection(sec("x", "nothing relevant"), ["kit"])).toBe(0);
  });

  it("prefers whole words over substrings", () => {
    const word = scoreSection(sec("x", "the pad fired"), ["pad"]);
    const substring = scoreSection(sec("x", "keypad handling"), ["pad"]);
    expect(word).toBeGreaterThan(substring);
  });
});

describe("excerptAround", () => {
  it("centres on the first hit rather than starting at the top", () => {
    const text = "a".repeat(800) + " NEEDLE " + "b".repeat(800);
    const out = excerptAround(text, ["needle"], 300);
    expect(out).toContain("NEEDLE");
    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("…")).toBe(true);
  });

  it("returns the head when the term is not in the text", () => {
    expect(excerptAround("short text", ["absent"], 100)).toBe("short text");
  });
});

describe("searchDocs", () => {
  it("finds the section that answers the question, not just the file", () => {
    const roots = corpus({
      "hil.md": "# HIL\n\nintro\n\n## Opening the console\n\nOpening the bridge VCP with DTR asserted resets the ESP.\n\n## Kits\n\nunrelated\n",
      "other.md": "# Other\n\nnothing to see\n",
    });
    const hits = searchDocs("DTR resets", 5, roots);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].heading).toBe("Opening the console");
    expect(hits[0].excerpt).toContain("DTR");
  });

  it("honours the limit", () => {
    const roots = corpus({
      "a.md": "## One\n\nkit\n\n## Two\n\nkit\n\n## Three\n\nkit\n",
    });
    expect(searchDocs("kit", 2, roots)).toHaveLength(2);
  });

  it("returns nothing for a query with no usable terms", () => {
    const roots = corpus({ "a.md": "## One\n\nkit\n" });
    expect(searchDocs("a  ,", 5, roots)).toEqual([]);
  });

  it("searches nested directories", () => {
    const roots = corpus({ "deep/nested/page.md": "## Buried\n\nthe answer is here\n" });
    expect(searchDocs("answer", 5, roots)[0].heading).toBe("Buried");
  });
});
