/**
 * Skills catalog sync guard. The skills in .claude/skills/ are described in four
 * places that must agree: the README's Agent Skills table, the catalog in
 * docs/SKILLS.md, and the AGENT SKILLS section of INSTRUCTIONS_TEXT (the
 * marklogic://instructions fallback for clients without skill support).
 *
 * Adding a skill without documenting it, or deleting one and leaving it in the
 * docs, is the failure mode this catches. Spec compliance (frontmatter rules,
 * dead reference links) is also asserted here so `npm test` covers what
 * `npm run validate:skills` checks — CI runs both.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { INSTRUCTIONS_TEXT } from "../../src/resources/index.js";

const SKILLS_DIR = ".claude/skills";
const README = "README.md";
const SKILLS_DOC = "docs/SKILLS.md";

const skillDirs = readdirSync(SKILLS_DIR)
  .filter((d) => statSync(path.join(SKILLS_DIR, d)).isDirectory())
  .sort();

const readme = readFileSync(README, "utf8");
const skillsDoc = readFileSync(SKILLS_DOC, "utf8");

/** The slice of a Markdown doc under `heading`, up to the next same-or-higher-level
 *  heading. Keeps the guard working when sections are reordered. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `document has no '${heading}' section`).toBeGreaterThan(-1);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Skill names from a Markdown catalog table: rows starting `| **\`name\`** |`. */
function catalogNames(text: string): string[] {
  return [...text.matchAll(/^\|\s*\*\*`([a-z0-9-]+)`\*\*\s*\|/gm)].map((m) => m[1]).sort();
}

/** Skill names from the AGENT SKILLS block of INSTRUCTIONS_TEXT: two-space-indented
 *  `name  description` lines, up to the Prompts: line. Continuation lines are
 *  indented far deeper and so do not match. */
function instructionsNames(text: string): string[] {
  const start = text.indexOf("AGENT SKILLS (");
  expect(start, "INSTRUCTIONS_TEXT has no AGENT SKILLS section").toBeGreaterThan(-1);
  const block = text.slice(start, text.indexOf("Prompts:", start));
  return [...block.matchAll(/^ {2}([a-z0-9][a-z0-9-]*) {2,}\S/gm)].map((m) => m[1]).sort();
}

describe("skills catalog sync", () => {
  it("found the skills on disk", () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    expect(skillDirs).toContain("marklogic"); // the router
  });

  it("the README Agent Skills table lists exactly the skills on disk", () => {
    expect(catalogNames(section(readme, "## Agent Skills"))).toEqual(skillDirs);
  });

  it("the docs/SKILLS.md catalog lists exactly the skills on disk", () => {
    expect(catalogNames(section(skillsDoc, "## The catalog"))).toEqual(skillDirs);
  });

  it("the AGENT SKILLS section of INSTRUCTIONS_TEXT lists exactly the skills on disk", () => {
    expect(instructionsNames(INSTRUCTIONS_TEXT)).toEqual(skillDirs);
  });

  describe.each(skillDirs)("%s", (dir) => {
    const file = path.join(SKILLS_DIR, dir, "SKILL.md");
    const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
    const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/);

    it("has SKILL.md with YAML frontmatter", () => {
      expect(existsSync(file), `${file} is missing`).toBe(true);
      expect(frontmatter, `${file} must open with --- delimited frontmatter`).not.toBeNull();
    });

    it("declares a spec-compliant name matching its directory", () => {
      const name = frontmatter?.[1].match(/^name:\s*(.*)$/m)?.[1].trim();
      expect(name, `${dir}: frontmatter is missing 'name'`).toBe(dir);
      expect(name!.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it("declares a non-empty description within the 1024-char spec limit", () => {
      const description = frontmatter?.[1].match(/^description:\s*(.*)$/m)?.[1].trim();
      expect(description, `${dir}: frontmatter is missing 'description'`).toBeTruthy();
      expect(description!.length).toBeLessThanOrEqual(1024);
    });

    it("links only to support files that exist", () => {
      const body = raw.slice(frontmatter?.[0].length ?? 0);
      const missing = [...body.matchAll(/(?:references|templates)\/[A-Za-z0-9._/-]+/g)]
        .map((m) => m[0])
        .filter((rel) => !existsSync(path.join(SKILLS_DIR, dir, rel)));
      expect([...new Set(missing)], `${dir}: SKILL.md links to missing file(s)`).toEqual([]);
    });
  });
});
