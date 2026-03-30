import { describe, it, expect } from "vitest";
import { parseMultipartMixed } from "../../src/utils/multipart.js";

const BOUNDARY = "ml-boundary-123";
const CT = `multipart/mixed; boundary=${BOUNDARY}`;

function buildPart(primitive: string, body: string): string {
  return `--${BOUNDARY}\r\nX-Primitive: ${primitive}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
}

function buildMultipart(parts: string[]): string {
  return parts.join("") + `--${BOUNDARY}--`;
}

// ─── parseMultipartMixed ───────────────────────────────────────────────────────

describe("parseMultipartMixed – boundary extraction", () => {
  it("returns raw body as string when Content-Type has no boundary", () => {
    const result = parseMultipartMixed("hello", "text/plain");
    expect(result).toEqual([{ primitive: "string", value: "hello" }]);
  });

  it("returns raw body when Content-Type is empty string", () => {
    const result = parseMultipartMixed("fallback", "");
    expect(result).toEqual([{ primitive: "string", value: "fallback" }]);
  });

  it("strips quotes from boundary value", () => {
    const body = buildMultipart([buildPart("string", "hi")]);
    const result = parseMultipartMixed(body, `multipart/mixed; boundary="${BOUNDARY}"`);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("hi");
  });
});

describe("parseMultipartMixed – type coercion", () => {
  it("coerces X-Primitive: integer to a number", () => {
    const body = buildMultipart([buildPart("integer", "42")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "integer", value: 42 }]);
  });

  it("coerces X-Primitive: decimal to a number", () => {
    const body = buildMultipart([buildPart("decimal", "3.14")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "decimal", value: 3.14 }]);
  });

  it("coerces X-Primitive: double to a number", () => {
    const body = buildMultipart([buildPart("double", "1.5e10")]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toBe(1.5e10);
  });

  it("coerces X-Primitive: float to a number", () => {
    const body = buildMultipart([buildPart("float", "0.5")]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toBe(0.5);
  });

  it("coerces X-Primitive: boolean true", () => {
    const body = buildMultipart([buildPart("boolean", "true")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "boolean", value: true }]);
  });

  it("coerces X-Primitive: boolean false", () => {
    const body = buildMultipart([buildPart("boolean", "false")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "boolean", value: false }]);
  });

  it("coerces X-Primitive: null-node() to null", () => {
    const body = buildMultipart([buildPart("null-node()", "null")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "null-node()", value: null }]);
  });

  it("coerces X-Primitive: null to null", () => {
    const body = buildMultipart([buildPart("null", "null")]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([{ primitive: "null", value: null }]);
  });

  it("JSON-parses JSON object body for string primitive", () => {
    const body = buildMultipart([buildPart("node()", JSON.stringify({ x: 1 }))]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toEqual({ x: 1 });
  });

  it("JSON-parses JSON array body", () => {
    const body = buildMultipart([buildPart("node()", JSON.stringify([1, 2, 3]))]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toEqual([1, 2, 3]);
  });

  it("keeps body as string when JSON parse fails", () => {
    const body = buildMultipart([buildPart("string", "not json {")]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].value).toBe("not json {");
  });

  it("uses 'string' as default primitive when X-Primitive header is absent", () => {
    const noPrimitivePart = `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nbare\r\n`;
    const body = buildMultipart([noPrimitivePart]);
    const result = parseMultipartMixed(body, CT);
    expect(result[0].primitive).toBe("string");
  });
});

describe("parseMultipartMixed – multiple parts", () => {
  it("parses multiple parts independently", () => {
    const body = buildMultipart([
      buildPart("integer", "10"),
      buildPart("string", "hello"),
      buildPart("boolean", "true"),
    ]);
    const result = parseMultipartMixed(body, CT);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ primitive: "integer", value: 10 });
    expect(result[1]).toEqual({ primitive: "string", value: "hello" });
    expect(result[2]).toEqual({ primitive: "boolean", value: true });
  });

  it("returns empty array for a multipart body with no content parts", () => {
    // Only the closing delimiter — no actual parts
    const body = `--${BOUNDARY}--`;
    const result = parseMultipartMixed(body, CT);
    expect(result).toEqual([]);
  });
});
