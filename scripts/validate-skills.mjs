#!/usr/bin/env node
/**
 * Validate .claude/skills/<name>/SKILL.md against the Agent Skills spec
 * (https://agentskills.io/specification).
 *
 * Checks the two required frontmatter fields and their constraints:
 *   name        — <=64 chars, lowercase/digits/hyphens, no leading/trailing or
 *                 doubled hyphen, and must match the containing directory
 *   description — <=1024 chars, non-empty
 *
 * Also verifies that every references/ and templates/ file mentioned in a
 * SKILL.md actually exists, so progressive-disclosure links cannot rot.
 *
 * Exits non-zero on any violation. Run via `npm run validate:skills`.
 */
import fs from "fs";
import path from "path";

const ROOT = ".claude/skills";
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const errors = [];
const summary = [];

if (!fs.existsSync(ROOT)) {
  console.error(`No ${ROOT} directory found.`);
  process.exit(1);
}

for (const dir of fs.readdirSync(ROOT).sort()) {
  const skillDir = path.join(ROOT, dir);
  if (!fs.statSync(skillDir).isDirectory()) continue;
  const file = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(file)) {
    errors.push(`${dir}: missing SKILL.md`);
    continue;
  }

  const raw = fs.readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    errors.push(`${dir}: missing YAML frontmatter delimited by --- at the very start`);
    continue;
  }

  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }

  const { name, description } = fm;

  if (!name) errors.push(`${dir}: frontmatter missing required field 'name'`);
  else {
    if (name.length > 64) errors.push(`${dir}: name is ${name.length} chars (max 64)`);
    if (!NAME_RE.test(name)) errors.push(`${dir}: name "${name}" must be lowercase letters/digits/hyphens, no leading, trailing or doubled hyphen`);
    if (name !== dir) errors.push(`${dir}: name "${name}" does not match its directory`);
  }

  if (!description) errors.push(`${dir}: frontmatter missing required field 'description'`);
  else if (description.length > 1024) errors.push(`${dir}: description is ${description.length} chars (max 1024)`);

  // Referenced support files must exist.
  const body = raw.slice(m[0].length);
  for (const ref of body.matchAll(/(?:references|templates)\/[A-Za-z0-9._/-]+/g)) {
    const p = path.join(skillDir, ref[0]);
    if (!fs.existsSync(p)) errors.push(`${dir}: references missing file ${ref[0]}`);
  }

  summary.push({
    skill: dir,
    descChars: description ? description.length : 0,
    bodyChars: body.length,
    support: fs.existsSync(path.join(skillDir, "references"))
      ? fs.readdirSync(path.join(skillDir, "references")).length
      : 0,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("skill", 36)}${pad("desc", 7)}${pad("body", 8)}refs`);
for (const r of summary) {
  console.log(`${pad(r.skill, 36)}${pad(r.descChars, 7)}${pad(r.bodyChars, 8)}${r.support}`);
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`\n✓ ${summary.length} skills valid against the Agent Skills spec.`);
