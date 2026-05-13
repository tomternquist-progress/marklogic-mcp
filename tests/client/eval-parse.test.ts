/**
 * Unit tests for EvalClient.parseCtsQuery — the read-only cts.parse() entrypoint
 * used by the chat → MarkLogic translation pipeline.
 *
 * These tests use nock to mock /v1/eval and assert:
 *  - The script we ship is fixed (no user code in the script body)
 *  - User input flows in via vars only (string-grammar text + bindings spec)
 *  - parseCtsQuery does NOT require allowEval (bypass parallels staticCheckSjs)
 *  - The eval response is parsed into structured-query JSON callers can use directly
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import nock from "nock";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { EvalClient } from "../../src/client/eval.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const HOST = "ml-parse-test.local";
const BASE_URL = `http://${HOST}:8000`;

const config: ConnectionConfig = {
  host: HOST,
  port: 8000,
  managementPort: 8002,
  username: "admin",
  password: "admin",
  database: "Documents",
  ssl: false,
  rejectUnauthorized: true,
  authType: "basic",
  timeoutMs: 5000,
};

const BOUNDARY = "ml-eval-boundary";
const CT = `multipart/mixed; boundary=${BOUNDARY}`;
function multipart(jsonValue: unknown): string {
  return (
    `--${BOUNDARY}\r\n` +
    `X-Primitive: object-node()\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(jsonValue) +
    `\r\n--${BOUNDARY}--`
  );
}

/** Construct a client where allowEval is intentionally FALSE — parseCtsQuery must work anyway. */
function makeClient(allowEval = false) {
  const base = new MarkLogicBaseClient(config);
  return new EvalClient(base, allowEval);
}

beforeAll(() => { nock.disableNetConnect(); });
afterAll(() => { nock.enableNetConnect(); });
afterEach(() => { nock.cleanAll(); });

describe("EvalClient.parseCtsQuery — wire-level", () => {
  it("works even when allowEval=false (matches staticCheckSjs precedent)", async () => {
    let sawJavascriptField = false;
    let sawVarsField = false;
    nock(BASE_URL)
      .post("/v1/eval", (body) => {
        // nock parses form-urlencoded bodies into objects — assert key presence.
        const obj = typeof body === "string" ? Object.fromEntries(new URLSearchParams(body)) : (body as Record<string, unknown>);
        sawJavascriptField = typeof obj.javascript === "string" && obj.javascript.length > 0;
        sawVarsField = typeof obj.vars === "string" && obj.vars.length > 0;
        return true;
      })
      .reply(200, multipart({ "word-query": { text: ["hello"] } }), { "content-type": CT });

    const client = makeClient(false);
    const out = await client.parseCtsQuery("hello");

    expect(out).toHaveLength(1);
    expect(out[0].value).toEqual({ "word-query": { text: ["hello"] } });
    expect(sawJavascriptField).toBe(true);
    expect(sawVarsField).toBe(true);
  });

  it("ships a FIXED script — no user-provided code in the script body", async () => {
    let capturedBody = "";
    nock(BASE_URL)
      .post("/v1/eval", (body) => { capturedBody = body as string; return true; })
      .reply(200, multipart({}), { "content-type": CT });

    await makeClient().parseCtsQuery("'); xdmp.documentDelete('/admin')", {
      // a "binding" with a malicious-looking name should also stay in data
      "evil; xdmp.shutdown(); //": { type: "json-property", name: "x" },
    });

    const params = new URLSearchParams(capturedBody);
    const script = params.get("javascript") ?? "";
    // The script must be the fixed parser shell — it must call cts.parse(qtext, bindings)
    expect(script).toContain("cts.parse(qtext, bindings)");
    // The script must NOT have interpolated the qtext or binding keys into the source —
    // those values flow through vars instead. Quotes from qtext must not appear in the script body.
    expect(script).not.toContain("xdmp.documentDelete");
    expect(script).not.toContain("xdmp.shutdown");
  });

  it("passes qtext and bindingsSpec through the vars JSON, not the script", async () => {
    let capturedBody = "";
    nock(BASE_URL)
      .post("/v1/eval", (body) => { capturedBody = body as string; return true; })
      .reply(200, multipart({}), { "content-type": CT });

    const bindings = {
      state: { type: "json-property", name: "state" },
      age:   { type: "json-property-range", name: "age", scalar_type: "int" },
    };
    await makeClient().parseCtsQuery("state:TX AND age:GE:65", bindings);

    const params = new URLSearchParams(capturedBody);
    const varsJson = params.get("vars") ?? "{}";
    const vars = JSON.parse(varsJson);
    expect(vars.qtext).toBe("state:TX AND age:GE:65");
    expect(vars.bindingsSpec).toEqual(bindings);
  });

  it("sends bindingsSpec=null when no bindings are supplied", async () => {
    let capturedBody = "";
    nock(BASE_URL)
      .post("/v1/eval", (body) => { capturedBody = body as string; return true; })
      .reply(200, multipart({}), { "content-type": CT });

    await makeClient().parseCtsQuery("plain AND boolean");

    const params = new URLSearchParams(capturedBody);
    const vars = JSON.parse(params.get("vars") ?? "{}");
    expect(vars).toEqual({ qtext: "plain AND boolean", bindingsSpec: null });
  });

  it("routes the database param onto the /v1/eval query string", async () => {
    let capturedQuery: string | undefined;
    nock(BASE_URL)
      .post("/v1/eval")
      .query((q) => { capturedQuery = JSON.stringify(q); return true; })
      .reply(200, multipart({}), { "content-type": CT });

    await makeClient().parseCtsQuery("anything", undefined, "ProjectDB");
    expect(capturedQuery).toContain("ProjectDB");
  });

  it("returns the cts.query JSON unchanged so callers can pipe it into structured_query", async () => {
    const parsed = {
      "and-query": {
        queries: [
          { "word-query": { text: ["diabetes"] } },
          { "json-property-value-query": { "property-name": "state", value: ["TX"] } },
        ],
      },
    };
    nock(BASE_URL).post("/v1/eval").reply(200, multipart(parsed), { "content-type": CT });

    const out = await makeClient().parseCtsQuery("diabetes AND state:TX", {
      state: { type: "json-property", name: "state" },
    });
    expect(out[0].value).toEqual(parsed);
  });

  it("propagates MarkLogic 500 errors as thrown errors", async () => {
    nock(BASE_URL).post("/v1/eval").reply(500, "XDMP-QUERY: unmatched quote");

    await expect(makeClient().parseCtsQuery('"unmatched'))
      .rejects.toThrow();
  });
});
