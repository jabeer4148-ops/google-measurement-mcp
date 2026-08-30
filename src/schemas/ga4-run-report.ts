/**
 * JSON Schema for ga4_run_report.
 *
 * Single source of truth (see docs/DESIGN.md §6): tool registration
 * references this object; it is never redeclared inline at the call site.
 */

export const ga4RunReportSchema = {
  type: "object",
  properties: {
    propertyId: {
      type: "string",
      description:
        "GA4 numeric property ID, with or without the 'properties/' prefix. Call ga4_list_account_summaries to discover it. This is NOT the G-XXXXXXX measurement ID.",
    },
    startDate: {
      type: "string",
      description:
        "Start of the range. Accepts YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo' (e.g. '28daysAgo').",
    },
    endDate: {
      type: "string",
      description:
        "End of the range, inclusive. Same formats as startDate.",
    },
    dimensions: {
      type: "array",
      items: { type: "string" },
      description:
        "GA4 dimension API names, e.g. ['date','sessionSource','country']. Omit for totals only.",
    },
    metrics: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "GA4 metric API names, e.g. ['activeUsers','sessions','conversions']. At least one is required.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description:
        "Maximum rows to return. Defaults to 25 to protect the context window. Prefer narrowing the query over raising this.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Zero-based row offset, for paging through a large report.",
    },
    keepEmptyRows: {
      type: "boolean",
      description:
        "When true, returns rows whose metrics are all zero. Defaults to false.",
    },
  },
  required: ["propertyId", "startDate", "endDate", "metrics"],
  additionalProperties: false,
} as const;

export interface Ga4RunReportInput {
  propertyId: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  metrics: string[];
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
}
