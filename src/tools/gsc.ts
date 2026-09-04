/**
 * Search Console tools (searchconsole v1). Read-only.
 *
 * API notes verified 2026-08-06 against
 * https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 *  - rowLimit range is 1..25,000, API default 1,000. Our D7 cap of 25 is far
 *    below that, so tool descriptions must say so or an agent will assume it is
 *    seeing everything.
 *  - `searchType` is deprecated; use `type`.
 *  - Paging uses `startRow` (an offset), not a page token.
 *  - FAQ searchAppearance support is being removed from the API in August 2026.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { mapGoogleError } from "../errors.js";
import { resolveLimit, truncateRows } from "../lib/truncate.js";
import { normalizeSiteUrl } from "../lib/normalize.js";
import { assertIsoDate, validateInput } from "../lib/validate.js";
import {
  gscInspectUrlSchema,
  gscListSitesSchema,
  gscSearchAnalyticsSchema,
  gscSiteOnlySchema,
} from "../schemas/phase2.js";
import { readAnnotations, type ToolDefinition } from "../schemas/index.js";

interface SearchAnalyticsInput {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  type?: string;
  dimensionFilterGroups?: unknown[];
  aggregationType?: string;
  dataState?: string;
  startRow?: number;
  limit?: number;
}

export function createGscTools(
  getClient: () => Promise<OAuth2Client>,
  config: Config,
): ToolDefinition[] {
  const gsc = async () => google.searchconsole({ version: "v1", auth: await getClient() });

  return [
    {
      name: "gsc_list_sites",
      title: "List Search Console properties",
      description:
        "Lists every Search Console property the authenticated user can access, with their permission level. " +
        "Use this FIRST to get the exact siteUrl string other Search Console tools need — the format is significant " +
        "('https://example.com/' for URL-prefix properties, 'sc-domain:example.com' for Domain properties). Read-only.",
      inputSchema: gscListSitesSchema as unknown as Record<string, unknown>,
      write: false,
      annotations: readAnnotations("List Search Console properties"),
      handler: async (raw: unknown) => {
        const input = validateInput<{ limit?: number }>(raw, gscListSitesSchema, "gsc_list_sites");
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        try {
          const client = await gsc();
          const res = await client.sites.list({});
          const rows = (res.data.siteEntry ?? []).map((s) => ({
            siteUrl: s.siteUrl ?? "",
            permissionLevel: s.permissionLevel ?? "",
            propertyType: (s.siteUrl ?? "").startsWith("sc-domain:") ? "domain" : "url-prefix",
          }));
          return truncateRows(rows, max);
        } catch (err) {
          throw mapGoogleError(err, "list Search Console sites");
        }
      },
    },

    {
      name: "gsc_search_analytics_query",
      title: "Query Search Console performance data",
      description:
        "Returns clicks, impressions, CTR and average position from Search Console, grouped by the dimensions you choose. " +
        "This is the primary SEO analysis tool. " +
        "siteUrl must be the exact string from gsc_list_sites. Dates are YYYY-MM-DD only — relative forms like '28daysAgo' are NOT supported here (unlike the GA4 tools). " +
        "Data lags roughly 2-3 days; use dataState='all' to include fresh partial data. " +
        "Returns at most 25 rows by default while the API itself allows up to 25,000, so do not assume you are seeing " +
        "everything — raise `limit` deliberately or narrow with filters. Page with `startRow`. Read-only.",
      inputSchema: gscSearchAnalyticsSchema as unknown as Record<string, unknown>,
      write: false,
      annotations: readAnnotations("Query Search Console performance data"),
      handler: async (raw: unknown) => {
        const input = validateInput<SearchAnalyticsInput>(
          raw,
          gscSearchAnalyticsSchema,
          "gsc_search_analytics_query",
        );
        assertIsoDate(input.startDate, "startDate", "gsc_search_analytics_query");
        assertIsoDate(input.endDate, "endDate", "gsc_search_analytics_query");

        const siteUrl = normalizeSiteUrl(input.siteUrl, "gsc_search_analytics_query");
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);
        const dimensions = input.dimensions ?? [];

        try {
          const client = await gsc();
          const res = await client.searchanalytics.query({
            siteUrl,
            requestBody: {
              startDate: input.startDate,
              endDate: input.endDate,
              dimensions,
              type: input.type,
              dimensionFilterGroups: input.dimensionFilterGroups as never,
              aggregationType: input.aggregationType,
              dataState: input.dataState,
              rowLimit: max + 1,
              startRow: input.startRow ?? 0,
            },
          });

          // GSC returns dimension values as a positional `keys` array. Re-attach
          // the dimension names so callers get self-describing rows.
          const rows = (res.data.rows ?? []).map((row) => {
            const flat: Record<string, string | number> = {};
            (row.keys ?? []).forEach((value, i) => {
              const name = dimensions[i] ?? `key${i}`;
              flat[name] = value;
            });
            flat["clicks"] = row.clicks ?? 0;
            flat["impressions"] = row.impressions ?? 0;
            flat["ctr"] = row.ctr ?? 0;
            flat["position"] = row.position ?? 0;
            return flat;
          });

          return {
            siteUrl,
            dateRange: { startDate: input.startDate, endDate: input.endDate },
            dimensions,
            type: input.type ?? "web",
            responseAggregationType: res.data.responseAggregationType ?? undefined,
            startRow: input.startRow ?? 0,
            ...truncateRows(rows, max),
          };
        } catch (err) {
          throw mapGoogleError(err, "query Search Console performance data");
        }
      },
    },

    {
      name: "gsc_list_sitemaps",
      title: "List submitted sitemaps",
      description:
        "Lists sitemaps submitted for a Search Console property, with last-downloaded time, warning and error counts, " +
        "and per-type indexed counts. Useful for diagnosing indexing problems. Read-only.",
      inputSchema: gscSiteOnlySchema as unknown as Record<string, unknown>,
      write: false,
      annotations: readAnnotations("List submitted sitemaps"),
      handler: async (raw: unknown) => {
        const input = validateInput<{ siteUrl: string; limit?: number }>(
          raw,
          gscSiteOnlySchema,
          "gsc_list_sitemaps",
        );
        const siteUrl = normalizeSiteUrl(input.siteUrl, "gsc_list_sitemaps");
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        try {
          const client = await gsc();
          const res = await client.sitemaps.list({ siteUrl });
          const rows = (res.data.sitemap ?? []).map((s) => ({
            path: s.path ?? "",
            type: s.type ?? "",
            lastSubmitted: s.lastSubmitted ?? "",
            lastDownloaded: s.lastDownloaded ?? "",
            isPending: s.isPending ?? false,
            isSitemapsIndex: s.isSitemapsIndex ?? false,
            warnings: Number(s.warnings ?? 0),
            errors: Number(s.errors ?? 0),
            contents: (s.contents ?? []).map((c) => ({
              type: c.type ?? "",
              submitted: Number(c.submitted ?? 0),
              indexed: Number(c.indexed ?? 0),
            })),
          }));
          return { siteUrl, ...truncateRows(rows, max) };
        } catch (err) {
          throw mapGoogleError(err, "list Search Console sitemaps");
        }
      },
    },

    {
      name: "gsc_inspect_url",
      title: "Inspect a URL's index status",
      description:
        "Returns Google's index status for a single URL: coverage verdict, last crawl time, " +
        "Google-selected vs user-declared canonical, mobile usability, and rich-results verdict. " +
        "QUOTA: 2,000 queries per day and 600 per minute PER PROPERTY. Do not loop this over a list of URLs " +
        "without checking the quota budget first — inspect specific URLs the user asked about, and prefer " +
        "gsc_search_analytics_query for anything aggregate. Read-only.",
      inputSchema: gscInspectUrlSchema as unknown as Record<string, unknown>,
      write: false,
      annotations: readAnnotations("Inspect a URL's index status"),
      handler: async (raw: unknown) => {
        const input = validateInput<{
          siteUrl: string;
          inspectionUrl: string;
          languageCode?: string;
        }>(raw, gscInspectUrlSchema, "gsc_inspect_url");

        const siteUrl = normalizeSiteUrl(input.siteUrl, "gsc_inspect_url");

        try {
          const client = await gsc();
          const res = await client.urlInspection.index.inspect({
            requestBody: {
              siteUrl,
              inspectionUrl: input.inspectionUrl,
              languageCode: input.languageCode,
            },
          });

          const result = res.data.inspectionResult ?? {};
          const index = result.indexStatusResult ?? {};

          return {
            siteUrl,
            inspectionUrl: input.inspectionUrl,
            inspectionResultLink: result.inspectionResultLink ?? undefined,
            indexStatus: {
              verdict: index.verdict ?? undefined,
              coverageState: index.coverageState ?? undefined,
              robotsTxtState: index.robotsTxtState ?? undefined,
              indexingState: index.indexingState ?? undefined,
              lastCrawlTime: index.lastCrawlTime ?? undefined,
              pageFetchState: index.pageFetchState ?? undefined,
              googleCanonical: index.googleCanonical ?? undefined,
              userCanonical: index.userCanonical ?? undefined,
              crawledAs: index.crawledAs ?? undefined,
              sitemap: index.sitemap ?? undefined,
              referringUrls: index.referringUrls ?? undefined,
            },
            mobileUsability: result.mobileUsabilityResult
              ? {
                  verdict: result.mobileUsabilityResult.verdict ?? undefined,
                  issueCount: (result.mobileUsabilityResult.issues ?? []).length,
                  issues: (result.mobileUsabilityResult.issues ?? []).map((i) => ({
                    issueType: i.issueType ?? "",
                    severity: i.severity ?? "",
                    message: i.message ?? "",
                  })),
                }
              : undefined,
            richResults: result.richResultsResult
              ? {
                  verdict: result.richResultsResult.verdict ?? undefined,
                  detectedItemTypes: (result.richResultsResult.detectedItems ?? []).map(
                    (d) => d.richResultType ?? "",
                  ),
                }
              : undefined,
            ampResult: result.ampResult ? { verdict: result.ampResult.verdict ?? undefined } : undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "inspect the URL in Search Console");
        }
      },
    },
  ];
}
