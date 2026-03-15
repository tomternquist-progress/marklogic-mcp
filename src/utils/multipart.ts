export interface EvalResult {
  primitive: string;
  value: unknown;
}

/**
 * Parse a MarkLogic multipart/mixed eval response into an array of typed results.
 * Each part carries an X-Primitive header that tells us the MarkLogic type.
 */
export function parseMultipartMixed(body: string, contentType: string): EvalResult[] {
  const boundaryMatch = contentType?.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return [{ primitive: "string", value: body }];

  const boundary = boundaryMatch[1].replace(/^"(.*)"$/, "$1");
  const parts = body.split(`--${boundary}`).slice(1);
  const results: EvalResult[] = [];

  for (const part of parts) {
    if (part.trim() === "--" || part.trim() === "") continue;
    const [headerSection, ...bodyParts] = part.split("\r\n\r\n");
    const bodyText = bodyParts.join("\r\n\r\n").replace(/\r\n$/, "");

    const primitiveMatch = headerSection?.match(/X-Primitive:\s*([^\r\n]+)/i);
    const primitive = primitiveMatch?.[1]?.trim() ?? "string";

    let value: unknown = bodyText;
    if (primitive === "integer" || primitive === "decimal" || primitive === "double" || primitive === "float") {
      value = Number(bodyText);
    } else if (primitive === "boolean") {
      value = bodyText === "true";
    } else if (primitive === "null-node()" || primitive === "null") {
      value = null;
    } else {
      try {
        value = JSON.parse(bodyText);
      } catch {
        value = bodyText;
      }
    }

    results.push({ primitive, value });
  }

  return results;
}
