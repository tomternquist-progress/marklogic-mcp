import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvalClient } from "../../src/client/eval.js";
import { EvalDisabledError } from "../../src/utils/errors.js";

function createMockBase() {
  const http = {
    post: vi.fn(),
  };
  return { http };
}

// ── allowEval=false gating ────────────────────────────────────────────────────

describe("EvalClient – allowEval=false", () => {
  let client: EvalClient;

  beforeEach(() => {
    client = new EvalClient(createMockBase() as never, false);
  });

  it("throws EvalDisabledError for evalXQuery", async () => {
    await expect(client.evalXQuery("1+1")).rejects.toThrow(EvalDisabledError);
  });

  it("throws EvalDisabledError for evalJavaScript", async () => {
    await expect(client.evalJavaScript("1+1")).rejects.toThrow(EvalDisabledError);
  });

  it("throws EvalDisabledError for invokeModule", async () => {
    await expect(client.invokeModule("/my-module.sjs")).rejects.toThrow(EvalDisabledError);
  });

  it("allows staticCheckSjs without allowEval (read-only syntax check)", async () => {
    const base = createMockBase();
    // staticCheckSjs bypasses allowEval; mock the underlying post
    const boundary = "ml-bound";
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: null-node()\r\n\r\nnull\r\n--${boundary}--`,
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    });
    const c = new EvalClient(base as never, false);
    // Should not throw even with allowEval=false
    await expect(c.staticCheckSjs("var x = 1;")).resolves.toBeNull();
  });
});

// ── evalXQuery ────────────────────────────────────────────────────────────────

describe("EvalClient.evalXQuery", () => {
  let base: ReturnType<typeof createMockBase>;
  let client: EvalClient;

  const boundary = "test-boundary";
  const CT = `multipart/mixed; boundary=${boundary}`;

  beforeEach(() => {
    base = createMockBase();
    client = new EvalClient(base as never, true);
  });

  it("posts to /v1/eval with xquery= body", async () => {
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: integer\r\n\r\n42\r\n--${boundary}--`,
      headers: { "content-type": CT },
    });

    const result = await client.evalXQuery("1+1");

    const [url, body] = base.http.post.mock.calls[0];
    expect(url).toBe("/v1/eval");
    expect(body).toContain("xquery=1%2B1");
    expect(result[0]).toEqual({ primitive: "integer", value: 42 });
  });

  it("includes vars as a JSON object in the body", async () => {
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: string\r\n\r\nhello\r\n--${boundary}--`,
      headers: { "content-type": CT },
    });

    await client.evalXQuery("$x", { x: "hello" });

    const [, body] = base.http.post.mock.calls[0];
    expect(body).toContain("vars=");
    expect(body).toContain(encodeURIComponent(JSON.stringify({ x: "hello" })));
  });

  it("does not include vars when empty", async () => {
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: string\r\n\r\nok\r\n--${boundary}--`,
      headers: { "content-type": CT },
    });

    await client.evalXQuery("fn:true()", {});

    const [, body] = base.http.post.mock.calls[0];
    expect(body).not.toContain("vars=");
  });

  it("passes database as query param", async () => {
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: string\r\n\r\nok\r\n--${boundary}--`,
      headers: { "content-type": CT },
    });

    await client.evalXQuery("1", undefined, "my-db");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.params.database).toBe("my-db");
  });
});

// ── evalJavaScript ────────────────────────────────────────────────────────────

describe("EvalClient.evalJavaScript", () => {
  it("posts to /v1/eval with javascript= body", async () => {
    const base = createMockBase();
    const client = new EvalClient(base as never, true);
    const boundary = "b1";
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: boolean\r\n\r\ntrue\r\n--${boundary}--`,
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    });

    await client.evalJavaScript("true");

    const [url, body] = base.http.post.mock.calls[0];
    expect(url).toBe("/v1/eval");
    expect(body).toContain("javascript=");
  });
});

// ── invokeModule ──────────────────────────────────────────────────────────────

describe("EvalClient.invokeModule", () => {
  it("posts to /v1/invoke with module= body", async () => {
    const base = createMockBase();
    const client = new EvalClient(base as never, true);
    const boundary = "b2";
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: string\r\n\r\nresult\r\n--${boundary}--`,
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    });

    const result = await client.invokeModule("/my-module.sjs");

    const [url, body] = base.http.post.mock.calls[0];
    expect(url).toBe("/v1/invoke");
    expect(body).toContain("module=");
    expect(result[0]).toEqual({ primitive: "string", value: "result" });
  });

  it("includes modules-database when modulesDb is provided", async () => {
    const base = createMockBase();
    const client = new EvalClient(base as never, true);
    const boundary = "b3";
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: null-node()\r\n\r\nnull\r\n--${boundary}--`,
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    });

    await client.invokeModule("/mod.sjs", undefined, undefined, "Modules");

    const [, body] = base.http.post.mock.calls[0];
    expect(body).toContain("modules-database=Modules");
  });
});

// ── staticCheckSjs ────────────────────────────────────────────────────────────

describe("EvalClient.staticCheckSjs", () => {
  it("returns null when no error", async () => {
    const base = createMockBase();
    const client = new EvalClient(base as never, true);
    const boundary = "b4";
    base.http.post.mockResolvedValue({
      data: `--${boundary}\r\nX-Primitive: null-node()\r\n\r\nnull\r\n--${boundary}--`,
      headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
    });

    const result = await client.staticCheckSjs("var x = 1;");
    expect(result).toBeNull();
  });

  it("returns error message string on syntax error", async () => {
    const base = createMockBase();
    const client = new EvalClient(base as never, true);
    base.http.post.mockRejectedValue(new Error("XDMP-UNEXPECTED: Unexpected token '{'"));

    const result = await client.staticCheckSjs("var x = {{{;");
    expect(result).toContain("XDMP-UNEXPECTED");
  });
});
