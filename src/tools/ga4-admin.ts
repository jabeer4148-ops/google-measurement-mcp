/**
 * GA4 Admin API tools (analyticsadmin v1beta). Read-only.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { mapGoogleError } from "../errors.js";
import { resolveLimit, truncateRows } from "../lib/truncate.js";
import { normalizePropertyId } from "../lib/normalize.js";
import { validateInput } from "../lib/validate.js";
import {
  ga4ListAccountSummariesSchema,
  ga4PropertyOnlySchema,
} from "../schemas/phase2.js";
import type { ToolDefinition } from "../schemas/index.js";

interface PropertyOnlyInput {
  propertyId: string;
  limit?: number;
  pageToken?: string;
}

export function createGa4AdminTools(
  getClient: () => Promise<OAuth2Client>,
  config: Config,
): ToolDefinition[] {
  const admin = async () =>
    google.analyticsadmin({ version: "v1beta", auth: await getClient() });

  return [
    {
      name: "ga4_list_account_summaries",
      title: "List GA4 accounts and properties",
      description:
        "Lists every Google Analytics account the authenticated user can see, with the properties under each. " +
        "Use this FIRST to discover the numeric propertyId that other GA4 tools require. " +
        "Returns account name, display name, and for each property its ID and display name. Read-only.",
      inputSchema: ga4ListAccountSummariesSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<{ limit?: number; pageToken?: string }>(
          raw,
          ga4ListAccountSummariesSchema,
          "ga4_list_account_summaries",
        );
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        try {
          const client = await admin();
          const res = await client.accountSummaries.list({
            pageSize: max + 1,
            pageToken: input.pageToken,
          });

          const rows = (res.data.accountSummaries ?? []).map((a) => ({
            account: a.account ?? "",
            accountId: (a.account ?? "").replace("accounts/", ""),
            accountName: a.displayName ?? "",
            properties: (a.propertySummaries ?? []).map((p) => ({
              property: p.property ?? "",
              propertyId: (p.property ?? "").replace("properties/", ""),
              propertyName: p.displayName ?? "",
              propertyType: p.propertyType ?? "",
            })),
          }));

          return {
            ...truncateRows(rows, max),
            nextPageToken: res.data.nextPageToken ?? undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "list GA4 account summaries");
        }
      },
    },

    {
      name: "ga4_list_custom_dimensions",
      title: "List GA4 custom dimensions",
      description:
        "Lists custom dimensions configured on a GA4 property, with parameter name, display name, and scope (EVENT/USER/ITEM). " +
        "Useful for discovering which custom dimensions exist before referencing them in ga4_run_report. Read-only.",
      inputSchema: ga4PropertyOnlySchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<PropertyOnlyInput>(
          raw,
          ga4PropertyOnlySchema,
          "ga4_list_custom_dimensions",
        );
        const parent = normalizePropertyId(input.propertyId, "ga4_list_custom_dimensions");
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        try {
          const client = await admin();
          const res = await client.properties.customDimensions.list({
            parent,
            pageSize: max + 1,
            pageToken: input.pageToken,
          });

          const rows = (res.data.customDimensions ?? []).map((d) => ({
            name: d.name ?? "",
            parameterName: d.parameterName ?? "",
            displayName: d.displayName ?? "",
            scope: d.scope ?? "",
            description: d.description ?? "",
            disallowAdsPersonalization: d.disallowAdsPersonalization ?? false,
          }));

          return {
            propertyId: parent,
            ...truncateRows(rows, max),
            nextPageToken: res.data.nextPageToken ?? undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "list GA4 custom dimensions");
        }
      },
    },

    {
      name: "ga4_list_key_events",
      title: "List GA4 key events",
      description:
        "Lists key events (formerly 'conversions') on a GA4 property, with counting method and whether each is deletable. " +
        "Read-only.",
      inputSchema: ga4PropertyOnlySchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<PropertyOnlyInput>(
          raw,
          ga4PropertyOnlySchema,
          "ga4_list_key_events",
        );
        const parent = normalizePropertyId(input.propertyId, "ga4_list_key_events");
        const max = resolveLimit(input.limit, config.defaultRowLimit, config.maxRowLimit);

        try {
          const client = await admin();
          const res = await client.properties.keyEvents.list({
            parent,
            pageSize: max + 1,
            pageToken: input.pageToken,
          });

          const rows = (res.data.keyEvents ?? []).map((k) => ({
            name: k.name ?? "",
            eventName: k.eventName ?? "",
            countingMethod: k.countingMethod ?? "",
            custom: k.custom ?? false,
            deletable: k.deletable ?? false,
            createTime: k.createTime ?? "",
          }));

          return {
            propertyId: parent,
            ...truncateRows(rows, max),
            nextPageToken: res.data.nextPageToken ?? undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "list GA4 key events");
        }
      },
    },
  ];
}
