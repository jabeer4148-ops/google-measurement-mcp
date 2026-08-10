/**
 * Schema-driven input validation.
 *
 * Phase 1 hand-wrote validation inside the one tool that existed. That does not
 * scale to fifteen, and hand-rolled checks drift from the declared schema — which
 * would break the contract discipline in handover D8, where the schema is meant to
 * be the single source of truth.
 *
 * This is a deliberately small validator rather than ajv, because the Phase 1 spec
 * pins runtime dependencies to `@modelcontextprotocol/sdk` and `googleapis`. It
 * covers exactly the JSON Schema subset these tools use. Anything outside that
 * subset is ignored rather than silently mis-validated — see SUPPORTED below.
 *
 * SUPPORTED: type (string/number/integer/boolean/array/object), required,
 * additionalProperties:false, enum, minItems, minimum, maximum, items.type,
 * items.enum.
 * NOT SUPPORTED: oneOf/anyOf/allOf, $ref, pattern, dependencies, nested object
 * properties. Do not add schema features here without extending the validator.
 */

import { ValidationError } from "../errors.js";

interface SchemaProperty {
  type?: string;
  enum?: readonly unknown[];
  minItems?: number;
  minimum?: number;
  maximum?: number;
  items?: { type?: string; enum?: readonly unknown[] };
  description?: string;
}

interface Schema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeOf(value) === "object";
    default:
      return true;
  }
}

/**
 * Validate `raw` against `schema`, throwing ValidationError on the first problem.
 *
 * Errors name the offending parameter and, where a fix is obvious, say what to do.
 * Every failure here happens *before* any network call — Phase 4 asserts that with
 * a spy on the API client.
 *
 * @param raw       Untrusted tool arguments.
 * @param schema    The tool's declared JSON Schema.
 * @param toolName  Used in messages so an agent knows which call failed.
 */
export function validateInput<T>(raw: unknown, schema: Schema, toolName: string): T {
  if (typeOf(raw) !== "object") {
    throw new ValidationError(
      `${toolName}: expected an object of arguments, received ${typeOf(raw)}.`,
    );
  }
  const input = raw as Record<string, unknown>;
  const properties = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    const allowed = Object.keys(properties);
    for (const key of Object.keys(input)) {
      if (!allowed.includes(key)) {
        throw new ValidationError(
          `${toolName}: unknown parameter "${key}".`,
          `Allowed parameters: ${allowed.join(", ")}.`,
        );
      }
    }
  }

  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === null) {
      throw new ValidationError(`${toolName}: missing required parameter "${key}".`);
    }
  }

  for (const [key, spec] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined) continue;

    if (spec.type && !matchesType(value, spec.type)) {
      throw new ValidationError(
        `${toolName}: "${key}" must be a ${spec.type}, received ${typeOf(value)}.`,
      );
    }

    if (spec.enum && !spec.enum.includes(value as never)) {
      throw new ValidationError(
        `${toolName}: "${key}" must be one of: ${spec.enum.join(", ")}. Received ${JSON.stringify(value)}.`,
      );
    }

    if (typeof value === "number") {
      if (spec.minimum !== undefined && value < spec.minimum) {
        throw new ValidationError(`${toolName}: "${key}" must be >= ${spec.minimum}, got ${value}.`);
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        throw new ValidationError(`${toolName}: "${key}" must be <= ${spec.maximum}, got ${value}.`);
      }
    }

    if (Array.isArray(value)) {
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        throw new ValidationError(
          `${toolName}: "${key}" must contain at least ${spec.minItems} item(s), got ${value.length}.`,
        );
      }
      const itemSpec = spec.items;
      if (itemSpec) {
        value.forEach((item, i) => {
          if (itemSpec.type && !matchesType(item, itemSpec.type)) {
            throw new ValidationError(
              `${toolName}: "${key}[${i}]" must be a ${itemSpec.type}, received ${typeOf(item)}.`,
            );
          }
          if (itemSpec.enum && !itemSpec.enum.includes(item as never)) {
            throw new ValidationError(
              `${toolName}: "${key}[${i}]" must be one of: ${itemSpec.enum.join(", ")}. Received ${JSON.stringify(item)}.`,
            );
          }
        });
      }
    }
  }

  return input as unknown as T;
}

/** GA4 accepts YYYY-MM-DD, 'today', 'yesterday', and 'NdaysAgo'. */
const GA4_DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;
/** Search Console accepts only YYYY-MM-DD. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertGa4Date(value: string, field: string, toolName: string): void {
  if (!GA4_DATE.test(value)) {
    throw new ValidationError(
      `${toolName}: "${field}" must be YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo'. Got ${JSON.stringify(value)}.`,
    );
  }
}

export function assertIsoDate(value: string, field: string, toolName: string): void {
  if (!ISO_DATE.test(value)) {
    throw new ValidationError(
      `${toolName}: "${field}" must be YYYY-MM-DD. Got ${JSON.stringify(value)}.`,
      "Search Console does not accept GA4-style relative dates such as '28daysAgo'.",
    );
  }
}
