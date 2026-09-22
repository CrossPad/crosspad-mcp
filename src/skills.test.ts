import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));

describe("plugin manifests", () => {
  it("plugin.json is named crosspad and mentions both skills", () => {
    const pj = readJson(".claude-plugin/plugin.json");
    expect(pj.name).toBe("crosspad");
    expect(pj.description).toMatch(/swd-tracer/);
    expect(pj.description).toMatch(/before-after/);
    expect(pj.description).toMatch(/onboard|help|getting started/i);
  });

  it("marketplace.json exposes one plugin named crosspad", () => {
    const mp = readJson(".claude-plugin/marketplace.json");
    expect(mp.plugins).toHaveLength(1);
    expect(mp.plugins[0].name).toBe("crosspad");
  });
});

describe("server instructions", () => {
  it("points new sessions at the crosspad skill first", () => {
    const src = read("src/index.ts");
    expect(src).toMatch(/SERVER_INSTRUCTIONS\s*=/);
    const block = src.split("SERVER_INSTRUCTIONS")[1] ?? "";
    // Backticks are escaped in the template literal (\`crosspad\`), so allow
    // backtick/backslash/space between "crosspad" and "skill".
    expect(block).toMatch(/crosspad[`\\ ]+skill first/i);
  });
});

describe("crosspad skill", () => {
  const dir = "skills/crosspad";

  it("SKILL.md has name: crosspad frontmatter and a routing table", () => {
    const md = read(`${dir}/SKILL.md`);
    expect(md).toMatch(/^---[\s\S]*?\nname:\s*crosspad\s*\n[\s\S]*?---/);
    expect(md).toMatch(/reference\/install\.md/);
    expect(md).toMatch(/reference\/faq\.md/);
    expect(md).toMatch(/swd-tracer/);
    expect(md).toMatch(/scripts\/doctor\.sh/);
  });

  it("ships all reference files", () => {
    for (const f of [
      "install.md", "repos.md", "role-user.md", "role-fw-dev.md",
      "role-contributor.md", "tools.md", "faq.md",
    ]) {
      expect(existsSync(resolve(root, dir, "reference", f))).toBe(true);
    }
  });

  it("ships executable doctor.sh and setup.sh", () => {
    for (const f of ["doctor.sh", "setup.sh"]) {
      const p = resolve(root, dir, "scripts", f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o100).toBeTruthy();
    }
  });
});

describe("before-after skill", () => {
  const dir = "skills/before-after";

  it("SKILL.md names itself and routes to both halves", () => {
    const md = read(`${dir}/SKILL.md`);
    expect(md).toMatch(/^---[\s\S]*?\nname:\s*before-after\s*\n[\s\S]*?---/);
    expect(md).toMatch(/reference\/pc-screenshots\.md/);
    expect(md).toMatch(/reference\/esp-perf\.md/);
    // The description is what makes the skill fire at all, so it has to carry
    // the words someone actually types when they want this.
    expect(md).toMatch(/description:[^\n]*regress/i);
  });

  it("ships the reference files", () => {
    for (const f of ["pc-screenshots.md", "esp-perf.md"]) {
      expect(existsSync(resolve(root, dir, "reference", f))).toBe(true);
    }
  });

  it("ships executable scripts for both halves", () => {
    for (const f of [
      "sim_ctl.sh", "sim_tour.py", "sim_kit_shot.py",
      "compare_shots.py", "esp_scroll_fps.py", "esp_fps_report.py",
    ]) {
      const p = resolve(root, dir, "scripts", f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o100).toBeTruthy();
    }
  });
});
