import { describe, it, expect } from "vitest";
import { parseMultipartMixed } from "../../src/utils/multipart.js";

const BOUNDARY = "ml-boundary-123";
const CT = `multipart/mixed; boundary=${BOUNDARY}`;

function buildMultipart(parts: Array<{ primitive: string; body: string }>): string {
  const segments = parts.map(({ primitive, body }) =>
    `\r\nContent-Type: text/plain\r\nX-Primitive: ${primitive}\r\n\r\n${body}\r\n`
  );
  return `--${BOUNDARY}${segments.join(`--${BOUNDARY}`)}--${BOUNDARY}--`;
}

// ── No boundary ───────────────────────────────────────────────────────────────

describe("parseMultipartMixed – no boundary in content-type", () => {
  it("returns the raw body as a string when boundary is missing", () => {
    const result = parseMultipartMixed("hello world", "text/plain");
    expect(result).toEqual([{ primitive: "string", value: "hello world" }]);
  });

  it("returns raw body when content-type is empty", () => {
    const result = parseMultipartMixed("data", "");
    expect(result).toEqual([{ primitive: "string", value: "data" }]);
  });
});

// ── Quoted boundary ────────────────────────────────────────────────────────────

describe("parseMultipartMixed – quoted boundary", () => {
  it("strips quotes from boundary value", () => {
    const body = buildMultipart([{ primitive: "string", body: "hello" }]);
    const result = parseMultipartMixed(body, `multipart/mixed; boundary="${BOUNDARY}"`);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("hello");
  });
});

// ── Numeric primitives ─────────────────────────────────────────────────────────

describe("parseMultipartMixed – numeric primitives", () => {
  it("parses integer as a JavaScript number", () => {
    const body = buildMultipart([{ primitive: "integer", body: "42" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "integer", value: 42 }]);
  });

  it("parses decimal as a JavaScript number", () => {
    const body = buildMultipart([{ primitive: "decimal", body: "3.14" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "decimal", value: 3.14 }]);
  });

  it("parses double as a JavaScript number", () => {
    const body = buildMultipart([{ primitive: "double", body: "2.718281828" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "double", value: 2.718281828 }]);
  });

  it("parses float as a JavaScript number", () => {
    const body = buildMultipart([{ primitive: "float", body: "1.5" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "float", value: 1.5 }]);
  });

  it("parses negative integer", () => {
    const body = buildMultipart([{ primitive: "integer", body: "-7" }]);
    const [r] = parseMultipartMixed(body, CT);
    expect(r.value).toBe(-7);
  });

  it("parses zero", () => {
    const body = buildMultipart([{ primitive: "integer", body: "0" }]);
    const [r] = parseMultipartMixed(body, CT);
    expect(r.value).toBe(0);
  });
});

// ── Boolean ───────────────────────────────────────────────────────────────────

describe("parseMultipartMixed – boolean primitive", () => {
  it('parses "true" body as boolean true', () => {
    const body = buildMultipart([{ primitive: "boolean", body: "true" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "boolean", value: true }]);
  });

  it('parses "false" body as boolean false', () => {
    const body = buildMultipart([{ primitive: "boolean", body: "false" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "boolean", value: false }]);
  });
});

// ── Null ──────────────────────────────────────────────────────────────────────

describe("parseMultipartMixed – null primitive", () => {
  it("parses null-node() as JS null", () => {
    const body = buildMultipart([{ primitive: "null-node()", body: "null" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "null-node()", value: null }]);
  });

  it("parses null as JS null", () => {
    const body = buildMultipart([{ primitive: "null", body: "null" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "null", value: null }]);
  });
});

// ── JSON fallback ─────────────────────────────────────────────────────────────

describe("parseMultipartMixed – JSON fallback for unknown primitives", () => {
  it("parses a JSON object body when primitive is 'object-node()'", () => {
    const obj = { name: "Alice", age: 30 };
    const body = buildMultipart([{ primitive: "object-node()", body: JSON.stringify(obj) }]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toEqual(obj);
  });

  it("parses a JSON array body when primitive is 'array-node()'", () => {
    const arr = [1, 2, 3];
    const body = buildMultipart([{ primitive: "array-node()", body: JSON.stringify(arr) }]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toEqual(arr);
  });

  it("falls back to raw string when body is not valid JSON", () => {
    const body = buildMultipart([{ primitive: "string", body: "plain text" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toBe("plain text");
  });

  it("parses JSON string literal as a JS string", () => {
    const body = buildMultipart([{ primitive: "string", body: '"hello"' }]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toBe("hello");
  });
});

// ── X-Primitive header missing ────────────────────────────────────────────────

describe("parseMultipartMixed – missing X-Primitive header", () => {
  it("defaults primitive to 'string' when header is absent", () => {
    const bodyStr =
      `--${BOUNDARY}\r\n` +
      `Content-Type: text/plain\r\n` +
      `\r\n` +
      `no-header-here\r\n` +
      `--${BOUNDARY}--`;
    const result = parseMultipartMixed(bodyStr, CT);
    expect(result[0].primitive).toBe("string");
  });
});

// ── Multiple parts ────────────────────────────────────────────────────────────

describe("parseMultipartMixed – multiple parts", () => {
  it("returns one result per part in order", () => {
    const body = buildMultipart([
      { primitive: "integer", body: "1" },
      { primitive: "string", body: "hello" },
      { primitive: "boolean", body: "true" },
    ]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ primitive: "integer", value: 1 });
    expect(result[1]).toEqual({ primitive: "string", value: "hello" });
    expect(result[2]).toEqual({ primitive: "boolean", value: true });
  });

  it("skips empty/terminator parts", () => {
    const body = buildMultipart([{ primitive: "integer", body: "99" }]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toHaveLength(1);
  });
});

// ── Body with embedded CRLF ───────────────────────────────────────────────────

describe("parseMultipartMixed – multi-line body", () => {
  it("preserves embedded newlines in a string body", () => {
    const multiline = "line1\r\nline2";
    const bodyStr =
      `--${BOUNDARY}\r\n` +
      `X-Primitive: string\r\n` +
      `\r\n` +
      `${multiline}\r\n` +
      `--${BOUNDARY}--`;
    const result = parseMultipartMixed(bodyStr, CT);
    expect(result[0].value).toBe(multiline);
  });
});
