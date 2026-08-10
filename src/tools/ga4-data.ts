/**
 * GA4 Data API tools (analyticsdata v1beta).
 *
 * Phase 1 ships exactly one tool as a proof of connection.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { ValidationError, mapGoogleError } from "../errors.js";
import { resolveLimit, truncateRows } from "../lib/truncate.js";
import { ga4RunReportSchema, type Ga4RunReportInput } from "../schemas/ga4-run-report.js";
import type { ToolDefinition } from "../schemas/index.js";

/** GA4 accepts YYYY-MM-DD, 'today', 'yesterday', and 'NdaysAgo'. */
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;

/** Accept '123456' or 'properties/123456'; the API wants the prefixed form. */
function normalizePropertyId(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("properties/") ? trimmed.slice("properties/".length) : trimmed;
  if (!/^\d+$/.test(bare)) {
    throw new ValidationError(
      `propertyId must be a numeric GA4 property ID, got "${raw}".`,
      "Use the numeric property ID from GA4 Admin → Property Settings, not the G-XXXXXXX measurement ID.",
    );
  }
  return `properties/${bare}`;
}

/**
 * Validate locally before any network call.
 *
 * Phase 4 asserts, with a spy, that malformed input never reaches Google.
 */
function validate(raw: unknown): Ga4RunReportInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("Expected an object of tool arguments.");
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(key in ga4RunReportSchema.properties)) {
      throw new ValidationError(
        `Unknown parameter "${key}".`,
        `Allowed parameters: ${Object.keys(ga4RunReportSchema.properties).join(", ")}.`,
      );
    }
  }

  for (const key of ga4RunReportSchema.required) {
    if (input[key] === undefined) {
      throw new ValidationError(`Missing required parameter "${key}".`);
    }
  }

  if (typeof input["propertyId"] !== "string") {
    throw new ValidationError("propertyId must be a string.");
  }

  for (const key of ["startDate", "endDate"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
      throw new ValidationError(
        `${key} must be YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo'. Got ${JSON.stringify(value)}.`,
      );
    }
  }

  const metrics = input["metrics"];
  if (!Array.isArray(metrics) || metrics.length === 0 || !metrics.every((m) => typeof m === "string")) {
    throw new ValidationError(
      "metrics must be a non-empty array of GA4 metric API names, e.g. ['activeUsers'].",
    );
  }

  const dimensions = input["dimensions"];
  if (dimensions !== undefined) {
    if (!Array.isArray(dimensions) || !dimensions.every((d) => typeof d === "string")) {
      throw new ValidationError("dimensions must be an array of GA4 dimension API names.");
    }
  }

  for (const key of ["limit", "offset"] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value))) {
      throw new ValidationError(`${key} must be an integer.`);
    }
  }

  if (input["keepEmptyRows"] !== undefined && typeof input["keepEmptyRows"] !== "boolean") {
    throw new ValidationError("keepEmptyRows must be a boolean.");
  }

  return input as unknown as Ga4RunReportInput;
}

export function createGa4DataTools(
  getClient: () => Promise<OAuth2Client>,
  config: Config,
): ToolDefinition[] {
  return [
    {
      name: "ga4_run_report",
      title: "Run a GA4 report",
      description:
        "Runs a Google Analytics 4 report and returns rows as flat objects. " +
        "Requires the NUMERIC GA4 propertyId (e.g. 543399494), not the G-XXXXXXX measurement ID. " +
        "If the user does not know it, it appears in any GA4 URL as the digits after 'p' " +
        "(analytics.google.com/analytics/web/#/a<account>p<property>/...), or under " +
        "GA4 Admin -> Property details -> PROPERTY ID. " +
        "Returns at most 25 rows unless `limit` is raised; prefer narrowing the date range or dimensions over raising it. " +
        "Read-only.",
      inputSchema: ga4RunReportSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validate(raw);
        const property = normalizePropertyId(input.propertyId);
        const limit = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        const auth = await getClient();
        const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

        try {
          const response = await analyticsdata.properties.runReport({
            property,
            requestBody: {
              dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
              dimensions: (input.dimensions ?? []).map((name) => ({ name })),
              metrics: input.metrics.map((name) => ({ name })),
              // Over-fetch by one so truncation is detectable even when GA4
              // omits rowCount.
              limit: String(limit + 1),
              offset: input.offset !== undefined ? String(input.offset) : undefined,
              keepEmptyRows: input.keepEmptyRows ?? false,
            },
          });

          const data = response.data;
          const dimensionHeaders = (data.dimensionHeaders ?? []).map((h) => h.name ?? "");
          const metricHeaders = (data.metricHeaders ?? []).map((h) => h.name ?? "");

          // Flatten GA4's parallel dimensionValues/metricValues arrays into flat
          // objects (handover Phase 1 requirement 7).
          const rows = (data.rows ?? []).map((row) => {
            const flat: Record<string, string | number> = {};
            (row.dimensionValues ?? []).forEach((cell, i) => {
              const key = dimensionHeaders[i];
              if (key) flat[key] = cell.value ?? "";
            });
            (row.metricValues ?? []).forEach((cell, i) => {
              const key = metricHeaders[i];
              if (!key) return;
              const raw = cell.value ?? "";
              const num = Number(raw);
              flat[key] = raw !== "" && Number.isFinite(num) ? num : raw;
            });
            return flat;
          });

          const result = truncateRows(rows, limit, data.rowCount ?? undefined);

          return {
            propertyId: property,
            dateRange: { startDate: input.startDate, endDate: input.endDate },
            dimensionHeaders,
            metricHeaders,
            ...result,
          };
        } catch (err) {
          throw mapGoogleError(err, "run the GA4 report");
        }
      },
    },
  ];
}
