/**
 * Live smoke tests — real Google APIs, real credentials.
 *
 * Skipped entirely unless GMCP_SMOKE=1. See ./README.md.
 *
 * These exist to catch what contract tests structurally cannot: a Google API
 * that renamed a field, changed a nesting level, or started rejecting a
 * request that used to be valid. Contract tests prove internal consistency
 * against a stub; only these prove the stub still resembles reality.
 *
 * Read-only. No writes, ever — see ./README.md for why.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { getAuthClient, describeSource } from "../../src/auth.js";
import { createGa4DataTools } from "../../src/tools/ga4-data.js";
import { createGa4AdminTools } from "../../src/tools/ga4-admin.js";
import { createGscTools } from "../../src/tools/gsc.js";
import { createGtmTools } from "../../src/tools/gtm.js";
import type { ToolDefinition } from "../../src/schemas/index.js";

const ENABLED = process.env["GMCP_SMOKE"] === "1";
const PROPERTY_ID = process.env["GMCP_SMOKE_PROPERTY_ID"];
const SITE_URL = process.env["GMCP_SMOKE_SITE_URL"];
const GTM_ACCOUNT_ID = process.env["GMCP_SMOKE_GTM_ACCOUNT_ID"];

const suite = ENABLED ? describe : describe.skip;

/** Build the read tools against whatever credentials actually resolve. */
async function readTools(): Promise<{ tools: ToolDefinition[]; source: string }> {
  const config = loadConfig([], process.env);
  const resolved = await getAuthClient("read", config, { interactive: false });
  const getClient = async () => resolved.client;
  return {
    tools: [
      ...createGa4DataTools(getClient, config),
      ...createGa4AdminTools(getClient, config),
      ...createGscTools(getClient, config),
      ...createGtmTools(getClient, config),
    ],
    source: describeSource(resolved.source),
  };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

suite("live smoke — credential resolution", () => {
  it("resolves credentials and reports which path was used", async () => {
    const { source } = await readTools();
    // Printed rather than asserted: which path resolves is environment-dependent,
    // and knowing WHICH one ran is the point when closing the auth-path gaps in
    // docs/TESTING.md §6.
    console.log(`  credential source: ${source}`);
    expect(source).toBeTruthy();
  });
});

suite("live smoke — GA4", () => {
  it.skipIf(!PROPERTY_ID)("ga4_list_account_summaries returns at least one account", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "ga4_list_account_summaries").handler({})) as {
      rows: Array<{ accountId: string; properties: unknown[] }>;
    };
    expect(Array.isArray(out.rows)).toBe(true);
    expect(out.rows.length).toBeGreaterThan(0);
  });

  it.skipIf(!PROPERTY_ID)("ga4_run_report returns rows with the requested headers", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "ga4_run_report").handler({
      propertyId: PROPERTY_ID,
      startDate: "28daysAgo",
      endDate: "today",
      dimensions: ["date"],
      metrics: ["activeUsers"],
      limit: 5,
    })) as { rows: Array<Record<string, unknown>>; dimensionHeaders: string[] };

    expect(out.dimensionHeaders).toContain("date");
    // A property with genuinely no traffic returns zero rows; that is a valid
    // response, not a failure. Assert shape, not volume.
    if (out.rows.length > 0) {
      expect(out.rows[0]).toHaveProperty("date");
      expect(out.rows[0]).toHaveProperty("activeUsers");
    }
  });

  it.skipIf(!PROPERTY_ID)("ga4_list_custom_dimensions handles an empty collection", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "ga4_list_custom_dimensions").handler({
      propertyId: PROPERTY_ID,
    })) as { rows: unknown[] };
    expect(Array.isArray(out.rows)).toBe(true);
  });
});

suite("live smoke — Search Console", () => {
  it("gsc_list_sites returns the accessible properties", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "gsc_list_sites").handler({})) as {
      rows: Array<{ siteUrl: string; propertyType: string }>;
    };
    expect(Array.isArray(out.rows)).toBe(true);
    for (const row of out.rows) {
      expect(["domain", "url-prefix"]).toContain(row.propertyType);
    }
  });

  it.skipIf(!SITE_URL)("gsc_search_analytics_query returns keyed rows", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "gsc_search_analytics_query").handler({
      siteUrl: SITE_URL,
      startDate: new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10),
      endDate: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10),
      dimensions: ["query"],
      limit: 5,
    })) as { rows: Array<Record<string, unknown>> };

    if (out.rows.length > 0) {
      // The positional `keys` array must have been re-attached to its names.
      expect(out.rows[0]).toHaveProperty("query");
      expect(out.rows[0]).toHaveProperty("clicks");
      expect(out.rows[0]).toHaveProperty("impressions");
    }
  });
});

suite("live smoke — Tag Manager", () => {
  it("gtm_list_accounts succeeds even with no accounts", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "gtm_list_accounts").handler({})) as { rows: unknown[] };
    // Zero accounts is a valid result, not an error — it means this identity
    // has no GTM access. See docs/API-NOTES.md.
    expect(Array.isArray(out.rows)).toBe(true);
  });

  it.skipIf(!GTM_ACCOUNT_ID)("gtm_list_containers reports both container IDs", async () => {
    const { tools } = await readTools();
    const out = (await tool(tools, "gtm_list_containers").handler({
      accountId: GTM_ACCOUNT_ID,
    })) as { rows: Array<{ containerId: string; publicId: string }> };

    for (const row of out.rows) {
      // The distinction the tool description warns about: containerId is the
      // numeric internal ID the API needs, publicId is the GTM-XXXXXXX string.
      expect(row.containerId).toMatch(/^\d+$/);
      expect(row.publicId).toMatch(/^GTM-/);
    }
  });
});
