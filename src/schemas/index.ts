/**
 * Schema registry.
 *
 * Every tool input schema is declared here and referenced by registration. This
 * is the contract-discipline requirement described in docs/DESIGN.md — docs and tests read
 * from the same objects the server registers.
 */

export { ga4RunReportSchema, type Ga4RunReportInput } from "./ga4-run-report.js";

/** Minimal shape shared by every tool definition in the registry. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are registered only when write mode is enabled (D4). */
  write: boolean;
  handler: (input: unknown) => Promise<unknown>;
}
