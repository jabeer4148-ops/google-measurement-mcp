/**
 * Schema registry.
 *
 * Every tool input schema is declared here and referenced by registration. This
 * is the contract-discipline requirement described in docs/DESIGN.md — docs and tests read
 * from the same objects the server registers.
 */

export { ga4RunReportSchema, type Ga4RunReportInput } from "./ga4-run-report.js";

/**
 * MCP tool annotations (spec: `Tool.annotations`).
 *
 * These are HINTS for client UX — deciding whether to prompt, batch, or retry.
 * The MCP spec is explicit that they are untrusted and must not be relied on for
 * security. The real controls in this server are the write flag, the absent
 * destructive tools, the unrequested scopes, and the publish confirm gate; the
 * annotations only describe them.
 *
 * All four are set explicitly on every tool rather than left to defaults,
 * because a missing or non-boolean value is treated as a defect by directory
 * validators and tells a client nothing.
 */
export interface ToolAnnotations {
  /** Human-readable title for display. */
  title: string;
  /** True when the tool does not modify its environment. */
  readOnlyHint: boolean;
  /**
   * True when the tool may perform destructive updates; false when it only
   * adds. Only meaningful when readOnlyHint is false.
   */
  destructiveHint: boolean;
  /**
   * True when repeating the call with the same arguments has no additional
   * effect. Only meaningful when readOnlyHint is false.
   */
  idempotentHint: boolean;
  /** True when the tool interacts with external entities — always true here. */
  openWorldHint: boolean;
}

/**
 * Every tool in this server talks to a Google API, so openWorldHint is always
 * true. Read tools never mutate, so they are also idempotent and non-destructive.
 */
export function readAnnotations(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

/**
 * @param destructive Whether the call can overwrite or replace existing state,
 *                    as opposed to only adding to it.
 * @param idempotent  Whether repeating the call with identical arguments leaves
 *                    the same end state rather than compounding.
 */
export function writeAnnotations(
  title: string,
  destructive: boolean,
  idempotent: boolean,
): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

/** Minimal shape shared by every tool definition in the registry. */
export interface ToolDefinition {
  /** MCP annotations. Required — never omitted, never partially populated. */
  annotations: ToolAnnotations;
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are registered only when write mode is enabled (D4). */
  write: boolean;
  handler: (input: unknown) => Promise<unknown>;
}
