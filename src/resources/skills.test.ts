import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillDocs, registerSkillResources, titleOf } from "./skills.js";
import { fakeServer } from "../testing/fake-server.js";
import type { ToolContext } from "../tool-context.js";

const made: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-skills-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeSkills(root: string): void {
  const ref = path.join(root, "skills", "crosspad", "reference");
  fs.mkdirSync(ref, { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "crosspad", "SKILL.md"),
    "---\nname: crosspad\ndescription: entry point\n---\n\n# CrossPad\n\nThe ecosystem map.\n",
  );
  fs.writeFileSync(path.join(ref, "hil-testing.md"), "# Hardware-in-the-loop testing\n\nTraps.\n");
  fs.writeFileSync(path.join(ref, "faq.md"), "## FAQ\n\nAnswers.\n");
  fs.writeFileSync(path.join(ref, "notes.txt"), "not markdown");
}

const ctx = {} as ToolContext;

describe("titleOf", () => {
  it("takes the first heading, past any frontmatter", () => {
    expect(titleOf("---\nname: x\n---\n\n# Real Title\n", "fallback")).toBe("Real Title");
  });
  it("accepts a level-two heading", () => {
    expect(titleOf("## FAQ\n", "fallback")).toBe("FAQ");
  });
  it("falls back to the file name when there is no heading", () => {
    expect(titleOf("just prose\n", "notes.md")).toBe("notes.md");
  });
});

describe("discoverSkillDocs", () => {
  it("finds SKILL.md and every reference page, ignoring non-markdown", () => {
    const root = tmpRoot();
    makeSkills(root);
    const docs = discoverSkillDocs(root);
    expect(docs.map((d) => d.id).sort()).toEqual(["crosspad", "crosspad/faq", "crosspad/hil-testing"]);
    expect(docs.find((d) => d.id === "crosspad")!.title).toBe("CrossPad");
    expect(docs.find((d) => d.id === "crosspad/hil-testing")!.title).toBe("Hardware-in-the-loop testing");
  });

  it("returns nothing rather than throwing when the package has no skills", () => {
    expect(discoverSkillDocs(tmpRoot())).toEqual([]);
  });
});

describe("registerSkillResources", () => {
  it("registers an index plus one resource per document", () => {
    const root = tmpRoot();
    makeSkills(root);
    const fsrv = fakeServer();
    const uris = registerSkillResources(fsrv.server, ctx, root);
    expect(uris).toContain("skill://index");
    expect(uris).toContain("skill://crosspad/hil-testing");
    expect(fsrv.resources.size).toBe(uris.length);
  });

  it("reads the file at request time, so an edit shows up without a restart", async () => {
    const root = tmpRoot();
    makeSkills(root);
    const fsrv = fakeServer();
    registerSkillResources(fsrv.server, ctx, root);
    const entry = [...fsrv.resources.values()].find((r) => r.name === "crosspad-skill-crosspad-faq")!;
    const read = entry.cb as () => Promise<{ contents: { text: string }[] }>;
    expect((await read()).contents[0].text).toContain("Answers.");
    fs.writeFileSync(path.join(root, "skills", "crosspad", "reference", "faq.md"), "## FAQ\n\nEdited.\n");
    expect((await read()).contents[0].text).toContain("Edited.");
  });

  it("lists every document in the index", async () => {
    const root = tmpRoot();
    makeSkills(root);
    const fsrv = fakeServer();
    registerSkillResources(fsrv.server, ctx, root);
    const index = [...fsrv.resources.values()].find((r) => r.name === "crosspad-skill-index")!;
    const read = index.cb as () => Promise<{ contents: { text: string }[] }>;
    const doc = JSON.parse((await read()).contents[0].text) as { count: number; docs: { uri: string }[] };
    expect(doc.count).toBe(3);
    expect(doc.docs.map((d) => d.uri)).toContain("skill://crosspad/faq");
  });
});
