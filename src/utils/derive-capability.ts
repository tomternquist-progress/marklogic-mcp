// Generate a ToolCapability manifest entry from a Zod schema shape — the
// same shape that's passed to server.tool() at registration. This closes
// the docs/runtime drift hole at the source: when a tool's parameter list
// changes, the manifest changes too, automatically, because both read from
// one Zod definition.

import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { ToolCapability } from "./capabilities.js";

/**
 * Build a ToolCapability from a Zod object shape (the dict the MCP SDK's
 * server.tool() takes as its third argument). Recursively unwraps optional /
 * default / nullable wrappers, formats a human-readable type string, and
 * pulls each field's .describe() description through.
 */
export function deriveCapability(
  name: string,
  description: string,
  shape: Record<string, ZodTypeAny>
): ToolCapability {
  const params = Object.entries(shape).map(([key, schema]) => ({
    name: key,
    type: describeType(schema),
    description: extractDescription(schema) ?? "",
  }));
  return { name, description, params };
}

/** Recursively pull the description from a Zod schema, including through
 *  optional/default/nullable wrappers. */
function extractDescription(schema: ZodTypeAny): string | undefined {
  const def = (schema as { _def?: { description?: string; innerType?: ZodTypeAny } })._def;
  if (def?.description) return def.description;
  if (def?.innerType) return extractDescription(def.innerType);
  return undefined;
}

/** Render a Zod schema as a compact, readable type string suitable for the
 *  capabilities manifest. Handles the common Zod combinators used in tool
 *  registrations; falls back to the Zod typeName for anything exotic. */
function describeType(schema: ZodTypeAny, opts: { optional?: boolean } = {}): string {
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return "unknown";
  const typeName = def.typeName as string | undefined;

  switch (typeName) {
    case "ZodOptional":
      return describeType(def.innerType as ZodTypeAny) + "?";
    case "ZodDefault":
      return describeType(def.innerType as ZodTypeAny);
    case "ZodNullable":
      return describeType(def.innerType as ZodTypeAny) + " | null";
    case "ZodString":
      return opts.optional ? "string?" : "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray": {
      const inner = describeType(def.type as ZodTypeAny);
      return `${inner}[]`;
    }
    case "ZodEnum": {
      const values = (def.values as string[]) ?? [];
      const literal = values.map((v) => `'${v}'`).join(" | ");
      return literal || "enum";
    }
    case "ZodLiteral":
      return typeof def.value === "string" ? `'${def.value}'` : String(def.value);
    case "ZodUnion": {
      const options = ((def.options as ZodTypeAny[]) ?? []).map((o) => describeType(o));
      return options.join(" | ");
    }
    case "ZodRecord":
      return "object";
    case "ZodObject":
      return "object";
    case "ZodEffects":
      // .refine() / .transform() wraps — describe the underlying schema.
      return describeType((def.schema as ZodTypeAny) ?? z.unknown());
    case "ZodAny":
    case "ZodUnknown":
      return "any";
    default:
      return typeName ? typeName.replace(/^Zod/, "").toLowerCase() : "unknown";
  }
}

/** Pull the set of accepted parameter names from a Zod shape. Used by the
 *  pruning middleware (ml_call) and by parity tests. */
export function knownParamKeys(shape: Record<string, ZodTypeAny>): Set<string> {
  return new Set(Object.keys(shape));
}
