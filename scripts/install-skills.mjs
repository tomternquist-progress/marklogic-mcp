#!/usr/bin/env node
/**
 * Copy this repository's Agent Skills into a place your agent will find them.
 *
 * The skills in .claude/skills/ are discovered automatically only when the agent
 * is running *inside this repository*. Anyone who connects the MarkLogic MCP
 * server to their own project gets the tools but not the guidance. This script
 * closes that gap.
 *
 *   node scripts/install-skills.mjs --list
 *   node scripts/install-skills.mjs --user                 # ~/.claude/skills
 *   node scripts/install-skills.mjs --project ~/my-app     # <dir>/.claude/skills
 *   node scripts/install-skills.mjs --dest ~/.copilot/skills   # verbatim dir (Copilot CLI)
 *   node scripts/install-skills.mjs --user --only marklogic,marklogic-rag
 *   node scripts/install-skills.mjs --user --dry-run
 *
 * Existing skill directories are left alone unless --force is passed, so a
 * re-run never silently discards local edits. Run via `npm run skills:install`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = path.resolve(fileURLToPath(import.meta.url), "..", "..", ".claude", "skills");

function parseArgs(argv) {
  const opts = { mode: null, target: null, only: null, force: false, dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--list":
        opts.list = true;
        break;
      case "--user":
        opts.mode = "user";
        break;
      case "--project":
        opts.mode = "project";
        // A bare --project means "the current directory".
        if (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.target = argv[++i];
        break;
      case "--dest":
        // Verbatim destination — for agents that look somewhere other than
        // .claude/skills (Copilot CLI reads ~/.copilot/skills, for example).
        opts.mode = "dest";
        opts.target = argv[++i];
        if (!opts.target || opts.target.startsWith("--")) fail("--dest requires a directory path.");
        break;
      case "--only":
        opts.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--force":
        opts.force = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        opts.list = true;
        opts.help = true;
        break;
      default:
        fail(`Unknown argument: ${arg}\nRun with --help for usage.`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readSkill(name) {
  const file = path.join(SOURCE, name, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const desc = fm?.[1].match(/^description:\s*(.*)$/m)?.[1] ?? "";
  return { name, description: desc.trim() };
}

function listSkills() {
  if (!fs.existsSync(SOURCE)) fail(`No skills directory found at ${SOURCE}`);
  return fs
    .readdirSync(SOURCE)
    .filter((d) => fs.statSync(path.join(SOURCE, d)).isDirectory())
    .sort()
    .map(readSkill)
    .filter(Boolean);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

const USAGE = `
Install the MarkLogic Agent Skills so your agent can discover them.

  --user                install to ~/.claude/skills (available in every project)
  --project [dir]       install to <dir>/.claude/skills (defaults to the current directory)
  --dest <dir>          install straight into <dir>, no .claude/skills suffix
                        (Copilot CLI: ~/.copilot/skills)
  --only a,b            install only the named skills (default: all)
  --force               overwrite skill directories that already exist
  --dry-run             print what would be copied and exit
  --list                list the available skills
`;

const opts = parseArgs(process.argv.slice(2));
const skills = listSkills();

if (opts.list || !opts.mode) {
  if (opts.help || !opts.mode) console.log(USAGE);
  console.log(`Available skills (${skills.length}) in ${SOURCE}:\n`);
  for (const s of skills) {
    // First sentence of the description is enough for a listing.
    const summary = s.description.split(/(?<=\.)\s/)[0];
    console.log(`  ${s.name}\n      ${summary}\n`);
  }
  if (!opts.mode && !opts.list) fail("Nothing installed: pass --user, --project <dir>, or --dest <dir>.");
  if (!opts.mode) {
    console.log("Install with:  npm run skills:install -- --user");
    process.exit(0);
  }
}

function expandHome(dir) {
  return dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

const destRoot =
  opts.mode === "user"
    ? path.join(os.homedir(), ".claude", "skills")
    : opts.mode === "dest"
    ? path.resolve(expandHome(opts.target))
    : path.join(path.resolve(expandHome(opts.target ?? process.cwd())), ".claude", "skills");

if (path.resolve(destRoot) === path.resolve(SOURCE)) {
  fail(
    `Target is this repository's own skills directory (${SOURCE}).\n` +
      `Skills here are already discovered automatically — nothing to install.`
  );
}

let selected = skills;
if (opts.only) {
  const known = new Set(skills.map((s) => s.name));
  const unknown = opts.only.filter((n) => !known.has(n));
  if (unknown.length) fail(`Unknown skill(s): ${unknown.join(", ")}\nRun with --list to see the available names.`);
  selected = skills.filter((s) => opts.only.includes(s.name));
}

const installed = [];
const skipped = [];

for (const skill of selected) {
  const dest = path.join(destRoot, skill.name);
  if (fs.existsSync(dest) && !opts.force) {
    skipped.push(skill.name);
    continue;
  }
  if (!opts.dryRun) {
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(path.join(SOURCE, skill.name), dest);
  }
  installed.push(skill.name);
}

const verb = opts.dryRun ? "Would install" : "Installed";
console.log(`${verb} ${installed.length} skill(s) → ${destRoot}`);
for (const name of installed) console.log(`  + ${name}`);

if (skipped.length) {
  console.log(`\nSkipped ${skipped.length} already present (pass --force to overwrite):`);
  for (const name of skipped) console.log(`  = ${name}`);
}

if (installed.length && !opts.dryRun) {
  console.log(
    `\nRestart your agent session to pick them up. Verify with /skills in Claude Code\n` +
      `or /skills list in Copilot CLI, or ask: "which MarkLogic skills do you have?"`
  );
}
