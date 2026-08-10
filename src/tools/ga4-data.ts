/**
 * GA4 Data API tools (analyticsdata v1beta).
 *
 * Phase 1 ships exactly one tool as a proof of connection.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { mapGoogleError } from "../errors.js";
import { resolveLimit, truncateRows } from "../lib/truncate.js";
import { ga4RunReportSchema, type Ga4RunReportInput } from "../schemas/ga4-run-report.js";
import { ga4RealtimeReportSchema } from "../schemas/phase2.js";
import { validateInput, assertGa4Date } from "../lib/validate.js";
import { normalizePropertyId } from "../lib/normalize.js";
import type { ToolDefinition } from "../schemas/index.js";

/** GA4 accepts YYYY-MM-DD, 'today', 'yesterday', and 'NdaysAgo'. */
const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;

/**
 * Validate locally before any network call.
 *
 * Structural checks come from the shared schema validator; the date-format rule
 * is expressed separately because it is a format constraint the validator's
 * supported subset does not cover.
 *
 * Phase 4 asserts, with a spy, that malformed input never reaches Google.
 */
function validate(raw: unknown): Ga4RunReportInput {
  const input = validateInput<Ga4RunReportInput>(raw, ga4RunReportSchema, "ga4_run_report");
  assertGa4Date(input.startDate, "startDate", "ga4_run_report");
  assertGa4Date(input.endDate, "endDate", "ga4_run_report");
  return input;
}

/** Flatten GA4's parallel dimensionValues/metricValues arrays into flat objects. */
function flattenRows(
  rows: Array<{
    dimensionValues?: Array<{ value?: string | null }> | null;
    metricValues?: Array<{ value?: string | null }> | null;
  }>,
  dimensionHeaders: string[],
  metricHeaders: string[],
): Record<string, string | number>[] {
  return rows.map((row) => {
    const flat: Record<string, string | number> = {};
    (row.dimensionValues ?? []).forEach((cell, i) => {
      const key = dimensionHeaders[i];
      if (key) flat[key] = cell.value ?? "";
    });
    (row.metricValues ?? []).forEach((cell, i) => {
      const key = metricHeaders[i];
      if (!key) return;
      const value = cell.value ?? "";
      const num = Number(value);
      flat[key] = value !== "" && Number.isFinite(num) ? num : value;
    });
    return flat;
  });
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
        const property = normalizePropertyId(input.propertyId, "ga4_run_report");
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
          const rows = flattenRows(data.rows ?? [], dimensionHeaders, metricHeaders);
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

    {
      name: "ga4_run_realtime_report",
      title: "Run a GA4 realtime report",
      description:
        "Returns activity from roughly the last 30 minutes. " +
        "Requires the NUMERIC GA4 propertyId (call ga4_list_account_summaries to find it). " +
        "IMPORTANT: the realtime schema is a SUBSET of the standard reporting schema — 'date', " +
        "'sessionSource' and most session-scoped fields are unavailable and will error. " +
        "Common realtime dimensions: country, city, deviceCategory, unifiedScreenName, eventName. " +
        "Common realtime metrics: activeUsers, screenPageViews, eventCount. " +
        "For anything older than 30 minutes use ga4_run_report instead. Read-only.",
      inputSchema: ga4RealtimeReportSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          propertyId: string;
          dimensions?: string[];
          metrics: string[];
          limit?: number;
        }>(raw, ga4RealtimeReportSchema, "ga4_run_realtime_report");

        const property = normalizePropertyId(input.propertyId, "ga4_run_realtime_report");
        const limit = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        const auth = await getClient();
        const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

        try {
          const response = await analyticsdata.properties.runRealtimeReport({
            property,
            requestBody: {
              dimensions: (input.dimensions ?? []).map((name) => ({ name })),
              metrics: input.metrics.map((name) => ({ name })),
              limit: String(limit + 1),
            },
          });

          const data = response.data;
          const dimensionHeaders = (data.dimensionHeaders ?? []).map((h) => h.name ?? "");
          const metricHeaders = (data.metricHeaders ?? []).map((h) => h.name ?? "");
          const rows = flattenRows(data.rows ?? [], dimensionHeaders, metricHeaders);

          return {
            propertyId: property,
            window: "last ~30 minutes",
            dimensionHeaders,
            metricHeaders,
            ...truncateRows(rows, limit, data.rowCount ?? undefined),
          };
        } catch (err) {
          throw mapGoogleError(err, "run the GA4 realtime report");
        }
      },
    },
  ];
}
