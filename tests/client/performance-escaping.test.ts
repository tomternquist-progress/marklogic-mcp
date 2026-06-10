/**
 * Regression tests for XQuery string-literal escaping in PerformanceClient.
 * XQuery escapes a double quote inside a string literal by DOUBLING it (""),
 * not with a backslash — replace(/"/g, '\\"') produced a malformed (and
 * technically injectable) query for names containing quotes.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import nock from "nock";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { PerformanceClient } from "../../src/client/performance.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const HOST = "ml-perf-escape-test.local";
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

function makeClient(): PerformanceClient {
  return new PerformanceClient(new MarkLogicBaseClient(config));
}

/** Extract the xquery field from the /v1/eval body — nock hands urlencoded
 *  bodies to the matcher pre-parsed as an object, raw strings otherwise. */
function xqueryFrom(body: unknown): string {
  if (typeof body === "string") return new URLSearchParams(body).get("xquery") ?? "";
  return String((body as Record<string, unknown>)?.xquery ?? "");
}

beforeAll(() => { nock.disableNetConnect(); });
afterAll(() => { nock.enableNetConnect(); });
afterEach(() => { nock.cleanAll(); });

describe("getForestCounts XQuery escaping", () => {
  it("doubles embedded quotes instead of backslash-escaping them", async () => {
    let sentXq = "";
    nock(BASE_URL)
      .post("/v1/eval", (body) => {
        sentXq = xqueryFrom(body);
        return true;
      })
      .reply(200, multipart({ active: 1, deleted: 0, standCount: 1, docCount: 1 }), {
        "Content-Type": CT,
      });

    const counts = await makeClient().getForestCounts('My "Quoted" Forest');
    expect(counts).toEqual({ active: 1, deleted: 0, standCount: 1, docCount: 1 });
    expect(sentXq).toContain('xdmp:forest("My ""Quoted"" Forest")');
    expect(sentXq).not.toContain('\\"');
  });
});

describe("forceMerge XQuery escaping", () => {
  it("doubles embedded quotes in the database name", async () => {
    let sentXq = "";
    nock(BASE_URL)
      .post("/v1/eval", (body) => {
        sentXq = xqueryFrom(body);
        return true;
      })
      .reply(200, multipart({ merged: ["F1"] }), { "Content-Type": CT });

    const result = await makeClient().forceMerge('db"name');
    expect(result).toEqual({ merged: ["F1"] });
    expect(sentXq).toContain('xdmp:database("db""name")');
    expect(sentXq).not.toContain('\\"');
  });
});
