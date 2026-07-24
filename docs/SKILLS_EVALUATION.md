# Tooling → Skills Evaluation

An assessment of which parts of the MarkLogic MCP server belong as MCP tools, which
should become skills, and which should stay as tools but be *complemented* by a skill.

Measured against the built server (`npm run build`, then a live `tools/list` /
`prompts/list` / `resources/list` over an in-memory transport), not by reading source.

---

## 1. The headline finding

| Surface | Count | Always-on context cost |
|---|---:|---:|
| MCP tools | 90 | **50,730 tokens** |
| MCP prompts | 25 | ~5,600 tokens (list only; bodies load on invoke) |
| MCP resources | 6 | list only, but `marklogic://instructions` is **15,591 tokens** when read |

**Every conversation starts ~50.7K tokens in the hole**, before the user has said
anything, and before a single MarkLogic document has been fetched. If a client also
reads `marklogic://instructions` — which the server explicitly tells it to — the
floor is ~66K.

The distribution is the real story:

```
 4184  flux_import          ← one tool = 8% of the entire tool budget
 2701  flux_reprocess
 2433  semaphore_kid_template_set
 1602  ml_search
 1568  ml_sparql_query
 1418  ml_parse_query
 1409  semaphore_concept_labels_update
 1400  ml_search_surface
 1270  ml_answer_query
 1187  semaphore_publish
 ...
```

**The top 15 tools consume 24,712 tokens — 49% of the total.** The remaining 60
tools together cost 15,992. The cost is not "we have a lot of tools." The cost is
that a handful of tools carry an entire operator's manual in their `description` and
`inputSchema`.

`flux_import` is the clearest case. Its description holds 9 numbered canonical
recipes, a Socrata `/rows.json` warning, a nested-API-wrapper workaround including a
copy-pasteable `python3 -c` one-liner, a Docker volume-mount caveat, and a
local-HTTP-server trick. Its `inputSchema` is 9,473 characters because each `.describe()`
string is itself a paragraph of troubleshooting prose. All of this is paid for on
every single request — including the ~95% of conversations that never import anything.

**That is the definition of content that should be progressively disclosed.**

---

## 2. The test I applied

For each tool, one question: **does invoking this require the model, or only inform it?**

- **Requires the model to act on something it cannot reach** (an HTTP call to
  MarkLogic, a Flux runner, a Semaphore server) → **stays a tool**. Skills cannot make
  authenticated calls into your cluster.
- **Only informs** — returns text derived from its own inputs, a lookup table, or a
  decision tree → **should be a skill**. The model can produce this itself given the
  knowledge; wrapping it in an RPC round-trip buys nothing and costs schema tokens.
- **Does I/O but needs a manual to call correctly** → **stays a tool, complemented by
  a skill**. The tool description shrinks to an interface contract; the manual moves
  into the skill and loads only when relevant.

---

## 3. Bucket A — move to skills, delete the tool

These handlers perform **zero I/O**. Verified by parsing each registered handler body
for calls into any client (`search.`, `documents.`, `flux.`, `semaphore.`, …) — these
six have none. They are pure functions from arguments to text.

| Tool | Tokens | What it actually is | Verdict |
|---|---:|---|---|
| `ml_suggest_approach` | 353 | 982 lines of regex → hardcoded advice, routing a natural-language task to a tool name | **Delete.** This is a router reimplemented in TypeScript, competing with the model's own tool selection. A skill (`marklogic-choosing-an-approach`) does this natively and stays current without regex maintenance. |
| `semaphore_kid_template_diagnose` | 1,020 | A `Record<symptom, string[]>` decision tree emitting a static remediation playbook | **Delete.** Textbook skill content — a troubleshooting runbook with no runtime state. |
| `semaphore_taxonomy_scaffold` | 959 | String-concatenates SKOS Turtle from its own arguments | **Delete.** Becomes a skill with a `template.ttl` reference file. Strictly better: the agent can adapt the template, which the fixed generator cannot. |
| `ml_gradle_scaffold` | 775 | Emits a static ml-gradle file map | **Delete.** Same reasoning. The source comment argues "a tool avoids LLM sampling errors in JSON" — but a skill with real template *files* the agent copies is more deterministic than a tool that streams file contents through the context window. |
| `ml_query_recipe` | 643 | Catalog + thin dispatch to other tools | **Split.** The `recipe='list'` path is documentation → skill. Keep the execute path only if you want a single-call shortcut. |
| `ml_capabilities` | 204 | Returns a hand-maintained manifest of *other tools'* parameters | **Delete.** Its own description admits the motive: "when documentation and runtime drift apart." A tool that exists to describe other tools' parameters is a symptom — fix the descriptions instead of shipping a second, hand-synced copy that can also drift. |

**Direct saving: 3,954 tokens, and ~2,600 lines of hand-maintained routing/templating
logic retired.**

---

## 4. Bucket B — keep the tool, move the prose into a skill

This is the large win. These do genuine I/O and **must** remain tools. What moves is
the manual bolted onto them.

| Tool | Now | Target | What moves out |
|---|---:|---:|---|
| `flux_import` | 4,184 | ~200 | 9 canonical recipes, Socrata caveats, JSONL preprocessing, nested-wrapper workaround, volume-mount caveats, local-HTTP-server trick |
| `flux_reprocess` | 2,701 | ~200 | Transform authoring patterns and failure modes |
| `semaphore_kid_template_set` | 2,433 | ~250 | Scoring-model theory, preset semantics, tuning guidance |
| `ml_search` | 1,602 | ~200 | Query-syntax tutorial |
| `ml_sparql_query` | 1,568 | ~150 | 5,010 chars of description against a 583-char schema — nearly pure tutorial |
| `ml_parse_query` | 1,418 | ~150 | `cts.parse` grammar reference |
| `semaphore_concept_labels_update` | 1,409 | ~200 | SKOS label-hygiene rules |
| `ml_search_surface` | 1,400 | ~150 | 4,461-char description on a 552-char schema — all explanation |
| `ml_answer_query` | 1,270 | ~250 | Projection/routing behaviour narrative |
| `semaphore_publish` | 1,187 | ~200 | Publish-pipeline theory |
| remaining `semaphore_*` (16 tools) | ~8,000 | ~3,000 | KMM/CLS conceptual model, shared across all of them |

The rule to apply: **a tool description should answer "what does this do, what does it
need, when do I pick it over its neighbour" in a few lines.** It should not answer "how
do I do bulk ingestion in MarkLogic." The second question is a skill.

Note the pattern visible in the numbers — `ml_sparql_query` (5,010-char description /
583-char schema) and `ml_search_surface` (4,461 / 552) have descriptions eight times
the size of their actual interface. That ratio is the tell.

**Projected: 50,730 → ~14,000 tokens (−72%), with no loss of capability.**

---

## 5. Bucket C — leave alone

`admin.ts`, `documents.ts`, `security.ts`, `extensions.ts`, `fasttrack.ts`,
`graphs.ts`, most of `schema.ts` and `quicksight.ts`. Together the bottom 60 tools
cost 15,992 tokens — roughly 265 each, which is a healthy interface-sized description.
They are already right. **Do not touch them**; the effort/return is concentrated
entirely in the top 15.

---

## 6. The 25 prompts — nearly all should be skills

Prompt bodies are already lazily loaded, so this is not primarily a token argument.
It is a **discovery** argument.

MCP prompts are, in most clients (Claude Code included), **user-invoked** — they surface
as slash commands. The model does not autonomously decide to use one. Skills are
**model-invoked**: the agent reads the description and pulls the skill in when the task
matches. For content that is explicitly meant to steer the agent's approach, user-invoked
is the wrong trigger. The prompt only fires if the human already knew to ask for it —
which defeats the purpose of `problem_advisor`.

**Convert to skills (advisors — should fire automatically):**
`problem_advisor` (9,499 chars), `data_modeling_advisor` (8,351), `rag_pipeline_designer`
(17,471), `semaphore_integration_advisor` (14,136), `oauth_setup_advisor` (11,741),
`envelope_pattern_advisor` (10,847), `project_setup_advisor` (10,354), `performance_advisor`
(9,023), `uri_designer` (7,589), `query_approach_advisor` (6,263), `data_import_advisor`
(4,012), `semaphore_model_workflow` (4,339).

**Convert to skills (generators):** `sjs_module_generator`, `tde_schema_generator`,
`nl_to_search_query` (7,112), `fasttrack_search_designer` (7,450), `fasttrack_app_scaffold`,
`xquery_function_generator`, `rest_extension_generator`, the four `*_query_builder`s.

**Keep as prompts:** `gdelt_import` and the QuickSight pair are narrow, one-shot,
"I know exactly what I want" flows. Slash-command ergonomics genuinely fit those.

`rag_pipeline_designer` at 17,471 chars is the sharpest example: it is a substantial
design methodology that currently fires only if someone types its name. As a skill it
would engage whenever a user asks about RAG over MarkLogic — which is when it is useful.

---

## 7. `marklogic://instructions` — the routing skill

`INSTRUCTIONS_TEXT` is 57,687 chars / **15,591 tokens** of problem→solution mapping.
It is the single best skill candidate in the repository: it is *entirely* a
"when you face problem X, reach for capability Y" document, which is precisely a skill's
job description.

Keep the resource for non-skill-aware clients (see §9), but the primary copy should
become the top-level `marklogic` skill — split so the router (~1,500 tokens) loads
first and the detail lives in reference files behind it.

---

## 8. The maintenance argument (the reason to do this beyond tokens)

`CLAUDE.md` currently mandates that adding one tool requires hand-updating **three**
separate copies of the same knowledge:

1. the tool's `description` string
2. the `INSTRUCTIONS_TEXT` problem table **and** the tool-groups list
3. Section 4 of the `problem_advisor` prompt

That instruction exists because the duplication is real. Measured:

- `flux_import` is referenced **66 times across 4 files** (`flux.ts` 10,
  `suggest-approach.ts` 15, `resources/index.ts` 15, `prompts/index.ts` 26).
- The Socrata `/rows.json` warning is independently restated in `tools/flux.ts`,
  `tools/suggest-approach.ts`, and `client/schema.ts`.

Three hand-synced copies of the same guidance is a drift generator — and `ml_capabilities`
exists *specifically* to paper over the drift, which is the clearest possible evidence
the structure is wrong. A skill collapses all three into one file that is versioned,
diffable, and impossible to half-update.

---

## 9. Portability — skills are a cross-vendor standard, not a Claude feature

**Agent Skills is an open specification, not a Claude Code construct.** The canonical
spec lives at [agentskills.io/specification](https://agentskills.io/specification);
`anthropics/skills` carries only a pointer file to it. A skill is a directory containing
`SKILL.md` — YAML frontmatter plus Markdown — with exactly two required fields:

```yaml
---
name: marklogic-bulk-import        # ≤64 chars, lowercase/digits/hyphens
description: ...                   # ≤1024 chars — what it does AND when to use it
---
```

Everything else (`license`, `allowed-tools`, `metadata`, `compatibility`) is optional.

**This matters for us: GitHub Copilot reads `.claude/skills` directly.** Copilot's
project-level skill discovery paths are `.github/skills`, `.claude/skills`, and
`.agents/skills`; personal skills live in `~/.copilot/skills` or `~/.agents/skills`.
Support spans Copilot CLI, the Copilot coding agent, code review, and agent mode in
VS Code and JetBrains. So the layout proposed in §10 is portable to Copilot CLI with
**zero changes and no second copy** — no symlink, no build step, no vendor-specific
directory.

Practical consequences for the plan:

- Write skills to `.claude/skills/` as proposed. Copilot CLI, Claude Code, and the other
  spec-adopting agents all pick them up from there. If you'd rather signal
  vendor-neutrality in the repo layout, `.agents/skills/` is read by both — but Claude
  Code's native path is `.claude/skills`, so that is the safer default.
- **Keep descriptions inside the 1,024-char limit.** Several current tool descriptions
  blow past it by 4–5× (`flux_import` at 5,752, `ml_sparql_query` at 5,010). Those cannot
  be pasted into frontmatter wholesale — the description must become a genuine
  *trigger* ("use when importing bulk data into MarkLogic from a URL, file, JDBC, or S3"),
  with the recipes moving into the skill body and `references/`. That constraint is a
  feature: it forces the split this evaluation is arguing for.
- Skills are discovered by directory scan, so they work for any client implementing the
  spec — including ones that never speak MCP at all.

### The residual caveat

The portability story covers *skill-aware* clients. A plain MCP client that implements
only the base protocol still sees nothing but tool descriptions. So the fallback below
is still required — it is just a narrower gap than it looked before:

Mitigation, and I'd treat this as a requirement rather than an option:

1. **Keep `marklogic://instructions` as the resource fallback.** Generate it from the
   same source files the skills use, so there is one authored copy and two rendered
   outputs — that keeps the §8 benefit intact rather than reintroducing the duplication
   under a new name.
2. **Ship skills in-repo** under `.claude/skills/`, so anyone cloning the repo picks them
   up automatically — in Claude Code *and* Copilot CLI, both of which scan that path.
   Optionally publish them for one-line install via `gh skills install` (GitHub CLI
   v2.90.0+), which installs spec-compliant skills for Copilot, Claude Code, and Cursor
   alike.
3. **Trim descriptions to interface contracts, not to stubs.** Prerequisites
   ("requires a TDE template in the Schemas database"), gating flags, and
   "use X instead when Y" pointers must *stay* in the tool description — a generic
   client still has to be able to call the tool correctly. What leaves is the
   tutorial content, not the contract.

With that, a skill-aware client gets progressive disclosure and a generic client is no
worse off than today.

---

## 10. Proposed skill set

Spec-compliant `SKILL.md` layout — read as-is by Claude Code, Copilot CLI, and other
agents implementing the Agent Skills spec:

```
.claude/skills/
  marklogic/                          # router — replaces INSTRUCTIONS_TEXT + ml_suggest_approach
    SKILL.md                          # problem→capability table (~1,500 tok)
    references/{search,analytics,graph,schema}.md
  marklogic-bulk-import/              # absorbs flux_import's manual + data_import_advisor + gdelt
    SKILL.md
    references/{socrata,jsonl-wrappers,jdbc,s3}.md
  marklogic-data-modeling/            # data_modeling_advisor + uri_designer + envelope_pattern_advisor
  marklogic-query-authoring/          # cts.parse grammar, Optic, SPARQL, structured queries
  marklogic-rag/                      # rag_pipeline_designer + ml_vector_search guidance
  marklogic-performance/              # performance_advisor + explain/profile interpretation
  marklogic-project-setup/            # ml_gradle_scaffold templates + project_setup_advisor + oauth
    templates/                        # real files, copied not generated
  semaphore-taxonomy/                 # KMM/CLS model, SKOS hygiene, taxonomy templates
  semaphore-classification-tuning/    # kid_template theory + the diagnose decision tree
```

Nine skills replacing 6 tools, ~20 prompts, and the bulk of 15 oversized descriptions.

---

## 11. Sequencing

Ordered by return on effort:

1. **`flux_import` alone** — 4,184 → ~200 tokens by extracting one skill. Single
   highest-value change in the repo; do it first as the pattern-setter.
2. **Delete Bucket A** (6 tools, 3,954 tokens, ~2,600 lines). Mechanical, low risk.
3. **Trim the remaining top-15 descriptions** into `marklogic-query-authoring` and the
   Semaphore skills. The bulk of the −72%.
4. **Convert the advisor prompts.** Improves behaviour (auto-discovery) more than tokens.
5. **Make `INSTRUCTIONS_TEXT` generated** from the skill sources, and rewrite the
   `CLAUDE.md` three-places-to-update rule to one place.

Steps 1–2 are independently shippable and reversible. Nothing here requires touching
the client layer, the transports, or the 60 tools in Bucket C.

---

## Summary

| | Now | After |
|---|---:|---:|
| Tools | 90 | 84 |
| Always-on tool tokens | 50,730 | ~14,000 |
| Guidance copies to hand-sync per change | 3 | 1 |
| Agents the guidance reaches | MCP clients only | any Agent Skills–compliant agent |

The tools are not the problem — the documentation stuffed inside them is. Keep every
tool that touches MarkLogic; move every tool that only explains MarkLogic.

---

## Sources

- [Agent Skills specification](https://agentskills.io/specification) — canonical spec
  (`anthropics/skills` `spec/agent-skills-spec.md` is a pointer to it)
- [GitHub Copilot now supports Agent Skills](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
- [Adding agent skills for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [About agent skills — GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [anthropics/skills](https://github.com/anthropics/skills)

Token counts in §1–§5 were measured directly against this repo's built server via a live
`tools/list` over an in-memory MCP transport. The frontmatter field limits in §9 are from
the published spec summaries; confirm against agentskills.io before relying on the exact
character caps.
