// Lightweight syntactic checks for SJS code before sending it to MarkLogic.
// Goal: turn opaque HTTP 500s into actionable correction hints by catching
// known-pitfall patterns at the client before the round-trip.
//
// These are heuristics. Anything we are not sure about, we let through and let
// the server speak. We never block execution — we only annotate.

export interface LintFinding {
  severity: "error" | "warning";
  message: string;
  hint: string;
}

export function lintSjs(code: string): LintFinding[] {
  const findings: LintFinding[] = [];

  // 1. cts.search() with a numeric/limit third argument. The third arg is
  //    actually "quality weight" — passing {limit:N} or 100 silently returns
  //    the wrong number of results (or errors). The proper pagination idiom
  //    is fn.subsequence(cts.search(...), start, length).
  // Walk cts.search( ... ) call sites by paren-matching so nested calls in arg
  // positions don't break the detection.
  for (const callArgs of extractCallArgs(code, "cts.search")) {
    if (callArgs.length >= 3 && /\{\s*limit\s*:/i.test(callArgs[2])) {
      findings.push({
        severity: "error",
        message: "cts.search() does not accept {limit:N} as a third argument.",
        hint:
          "The third argument to cts.search is the quality weight, not a limit. " +
          "Use fn.subsequence(cts.search(query, options), start, length) to page results.",
      });
      break;
    }
  }

  // 2. Object literal as the final expression — JS parses it as a block.
  //    Look for the pattern `\n{ ... }\s*$` at the end of the script with
  //    `key: value` inside it.
  const trailing = code.trim();
  if (/\}\s*$/.test(trailing) && /(^|\n)\s*\{\s*[A-Za-z_$][\w$]*\s*:/.test(trailing)) {
    // Skip if it's wrapped in parens already.
    const lastLines = trailing.split("\n").slice(-10).join("\n");
    if (!/\(\s*\{[\s\S]*\}\s*\)\s*;?\s*$/.test(lastLines) && !/return\s*\{/.test(lastLines)) {
      findings.push({
        severity: "warning",
        message: "Trailing { key: value } is parsed as a block statement, not a return value.",
        hint:
          "Wrap the final object in parens — `({ key: value })` — or assign it to a variable and " +
          "return that variable as the last expression.",
      });
    }
  }

  // 3. .toArray() on cts.search / sequences. Use Array.from() instead.
  if (/\.toArray\s*\(\s*\)/.test(code) && /cts\.search|sem\.sparql|op\./.test(code)) {
    findings.push({
      severity: "warning",
      message: "MarkLogic Sequence does not have a .toArray() method in some SJS contexts.",
      hint: "Use Array.from(<sequence>) to materialize a Sequence into an array reliably.",
    });
  }

  // 4. xdmp.httpPost(...) with a flat headers object (missing 'headers' key).
  if (/xdmp\.httpPost\s*\([^,]*,\s*\{\s*['"][A-Za-z-]+['"]\s*:/.test(code)) {
    findings.push({
      severity: "warning",
      message: "xdmp.httpPost() options must nest under a 'headers' key.",
      hint:
        "Wrap header entries: { headers: { 'Content-Type': '...' } } — a flat options object " +
        "triggers XDMP-INVOPTNAM.",
    });
  }

  // 5. Optic plan variable named 'plan' — clashes with an internal variable in
  //    optic-amped.sjs and throws ReferenceError: plan is not defined.
  if (/\b(?:var|let|const)\s+plan\s*=\s*op\./.test(code)) {
    findings.push({
      severity: "warning",
      message: "Naming an Optic plan variable 'plan' clashes with optic-amped.sjs internals.",
      hint: "Rename the variable to q, query, myPlan, or any other identifier.",
    });
  }

  // 6. op.fromView(...).count() — not a real API.
  if (/op\.from\w+\([^)]*\)\.count\s*\(/.test(code)) {
    findings.push({
      severity: "error",
      message: "Optic does not have a .count() method on plans.",
      hint:
        "Use groupBy with op.count: op.fromView('s','v').groupBy(null, op.count('n', op.col('any'))) — " +
        "passing null as the first arg means 'no group key', counting all rows.",
    });
  }

  // 7. Use of `external` in SJS modules (ML 12 removed this).
  if (/\bexternal\.[A-Za-z_]/.test(code) && /\bxdmp\.getRequestField\b/.test(code) === false) {
    findings.push({
      severity: "warning",
      message: "ML 12 does not expose an `external` global in SJS modules.",
      hint:
        "Read vars via JSON.parse(xdmp.getRequestField('vars') || '{}') instead of referencing external.<name>.",
    });
  }

  return findings;
}

/**
 * Find each call to `name(...)` in source and return the top-level argument
 * strings. Handles nested parens, brackets, and braces; ignores `name` inside
 * a string literal. Quick & dirty — designed for lint hints, not parsing.
 */
function extractCallArgs(source: string, name: string): string[][] {
  const out: string[][] = [];
  let idx = 0;
  while (idx < source.length) {
    const found = source.indexOf(name, idx);
    if (found === -1) break;
    // Require the next non-space char to be '('
    let p = found + name.length;
    while (p < source.length && /\s/.test(source[p])) p++;
    if (source[p] !== "(") {
      idx = found + 1;
      continue;
    }
    // Walk the args, respecting nesting and string literals.
    const args: string[] = [];
    let depth = 1;
    let buf = "";
    let inStr: string | null = null;
    p++;
    while (p < source.length && depth > 0) {
      const ch = source[p];
      if (inStr) {
        if (ch === "\\") {
          buf += ch + source[p + 1];
          p += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
        buf += ch;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        buf += ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
        buf += ch;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) break;
        buf += ch;
      } else if (ch === "," && depth === 1) {
        args.push(buf.trim());
        buf = "";
      } else {
        buf += ch;
      }
      p++;
    }
    if (buf.trim().length) args.push(buf.trim());
    out.push(args);
    idx = p + 1;
  }
  return out;
}

export function formatLintFindings(findings: LintFinding[]): string {
  if (!findings.length) return "";
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.length - errorCount;
  const header = `Eval preflight found ${errorCount} error(s) and ${warnCount} warning(s):`;
  const body = findings
    .map((f) => `  [${f.severity}] ${f.message}\n     Hint: ${f.hint}`)
    .join("\n");
  return `${header}\n${body}`;
}
