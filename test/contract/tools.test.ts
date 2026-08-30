/**
 * Per-tool contract tests (see docs/TESTING.md).
 *
 * The central assertion: malformed input is rejected LOCALLY, before any API
 * call. Proven with a spy on the stubbed client rather than by inspecting the
 * error type alone — an error could be raised after a request was already sent.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { GmcpError } from "../../src/errors.js";
import { resolveLimit, truncateRows } from "../../src/lib/truncate.js";
import {
  buildTools,
  calls,
  callsTo,
  googleError,
  installStubs,
  resetCalls,
} from "./helpers.js";

const EXPECTED_READ = [
  "ga4_run_report",
  "ga4_run_realtime_report",
  "ga4_list_account_summaries",
  "ga4_list_custom_dimensions",
  "ga4_list_key_events",
  "gsc_list_sites",
  "gsc_search_analytics_query",
  "gsc_list_sitemaps",
  "gsc_inspect_url",
  "gtm_list_accounts",
  "gtm_list_containers",
  "gtm_list_workspaces",
  "gtm_list_tags",
  "gtm_list_triggers",
  "gtm_list_variables",
];

const EXPECTED_WRITE = [
  "ga4_create_custom_dimension",
  "ga4_create_key_event",
  "ga4_update_key_event",
  "gsc_submit_sitemap",
  "gtm_create_tag",
  "gtm_update_tag",
  "gtm_create_trigger",
  "gtm_create_version",
  "gtm_publish_version",
];

/** Never implemented (see docs/DESIGN.md §2). Asserting absence is the point. */
const FORBIDDEN = [
  "ga4_delete_key_event",
  "ga4_archive_custom_dimension",
  "gsc_delete_sitemap",
  "gsc_add_site",
  "gsc_delete_site",
  "gtm_delete_tag",
  "gtm_delete_trigger",
  "gtm_delete_variable",
  "gtm_delete_container",
  "gtm_delete_version",
];

beforeEach(() => {
  resetCalls();
  installStubs();
});

// ------------------------------------------------------------------ gating

describe("write gating (see docs/DESIGN.md §1)", () => {
  it("registers zero write tools when the flag is off", async () => {
    const { read, write } = await buildTools("read");
    expect(write).toHaveLength(0);
    expect(read.map((t) => t.name).sort()).toEqual([...EXPECTED_READ].sort());
  });

  /**
   * Asserted against an explicit name list rather than a snapshot or a count.
   * A snapshot silently absorbs a tool added later — the exact failure mode
   * recorded in docs/TESTING.md.
   */
  it("exposes exactly the expected write tools when the flag is on", async () => {
    const { write } = await buildTools("write");
    expect(write.map((t) => t.name).sort()).toEqual([...EXPECTED_WRITE].sort());
  });

  it("marks every write tool write:true and every read tool write:false", async () => {
    const { read, write } = await buildTools("write");
    expect(read.every((t) => !t.write)).toBe(true);
    expect(write.every((t) => t.write)).toBe(true);
  });

  it("never exposes a destructive tool, in either mode", async () => {
    for (const mode of ["read", "write"] as const) {
      const { all } = await buildTools(mode);
      const names = all.map((t) => t.name);
      for (const forbidden of FORBIDDEN) expect(names).not.toContain(forbidden);
    }
  });

  it("registers no duplicate tool names", async () => {
    const { all } = await buildTools("write");
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// -------------------------------------------------- validation before I/O

describe("invalid input is rejected before any API call", () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["ga4_run_report", { propertyId: "G-ABC", startDate: "2026-01-01", endDate: "today", metrics: ["x"] }],
    ["ga4_run_report", { propertyId: "1", startDate: "nope", endDate: "today", metrics: ["x"] }],
    ["ga4_run_report", { propertyId: "1", startDate: "2026-01-01", endDate: "today", metrics: [] }],
    ["ga4_run_report", { propertyId: "1", startDate: "2026-01-01", endDate: "today", metrics: ["x"], bogus: 1 }],
    ["ga4_run_realtime_report", { propertyId: "G-ABC", metrics: ["activeUsers"] }],
    ["ga4_list_custom_dimensions", { propertyId: "not-numeric" }],
    ["gsc_search_analytics_query", { siteUrl: "example.com", startDate: "2026-01-01", endDate: "2026-01-02" }],
    ["gsc_search_analytics_query", { siteUrl: "https://x.com/", startDate: "28daysAgo", endDate: "2026-01-02" }],
    ["gsc_search_analytics_query", { siteUrl: "https://x.com/", startDate: "2026-01-01", endDate: "2026-01-02", dimensions: ["nope"] }],
    ["gsc_inspect_url", { siteUrl: "https://x.com/" }],
    ["gtm_list_tags", { accountId: "1" }],
    ["gtm_list_tags", { path: "accounts/1/containers/2" }],
  ];

  for (const [toolName, args] of invalid) {
    it(`${toolName} rejects ${JSON.stringify(args).slice(0, 60)}`, async () => {
      const { all } = await buildTools("write");
      const tool = all.find((t) => t.name === toolName)!;
      resetCalls();
      await expect(tool.handler(args)).rejects.toThrow();
      // The point of the test: nothing reached Google.
      expect(calls).toHaveLength(0);
    });
  }

  it("raises ValidationError specifically, not a generic failure", async () => {
    const { all } = await buildTools("write");
    const tool = all.find((t) => t.name === "ga4_run_report")!;
    await expect(
      tool.handler({ propertyId: "G-ABC", startDate: "2026-01-01", endDate: "today", metrics: ["x"] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// ------------------------------------------------------- output conformance

describe("output shapes", () => {
  it("ga4_run_report flattens GA4 parallel arrays into flat objects", async () => {
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "ga4_run_report")!;
    const out = (await tool.handler({
      propertyId: "123456789",
      startDate: "28daysAgo",
      endDate: "today",
      dimensions: ["date"],
      metrics: ["activeUsers"],
    })) as { rows: Array<Record<string, unknown>>; rowCount: number };

    expect(out.rows[0]).toEqual({ date: "20260801", activeUsers: 12 });
    expect(typeof out.rows[0]!["activeUsers"]).toBe("number");
    expect(out.rowCount).toBe(2);
  });

  it("gsc_search_analytics_query re-attaches dimension names to positional keys", async () => {
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "gsc_search_analytics_query")!;
    const out = (await tool.handler({
      siteUrl: "https://example.com/",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      dimensions: ["query"],
    })) as { rows: Array<Record<string, unknown>> };

    expect(out.rows[0]).toMatchObject({ query: "shoes", clicks: 5, impressions: 100 });
  });

  it("normalizes a bare property ID to the prefixed form Google expects", async () => {
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "ga4_run_report")!;
    await tool.handler({
      propertyId: "123456789",
      startDate: "28daysAgo",
      endDate: "today",
      metrics: ["activeUsers"],
    });
    const call = callsTo("runReport")[0]!;
    expect((call.args as { property: string }).property).toBe("properties/123456789");
  });
});

// ------------------------------------------------------------- truncation

describe("truncation (see docs/DESIGN.md §6)", () => {
  it("returns exactly `limit` rows with truncated:true and a correct totalRows", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i }));
    const out = truncateRows(rows, 25, 40);
    expect(out.rows).toHaveLength(25);
    expect(out.truncated).toBe(true);
    expect(out.totalRows).toBe(40);
  });

  it("omits truncated when nothing was clipped", () => {
    const out = truncateRows([{ i: 1 }], 25, 1);
    expect(out.truncated).toBeUndefined();
    expect(out.rows).toHaveLength(1);
  });

  /**
   * Callers over-fetch by one to detect truncation. If the API reported no
   * total, saying "25 of 26" would imply near-completeness when the real total
   * might be 40,000 — docs/DESIGN.md §6.
   */
  it("does not invent a total when the API did not report one", () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ i }));
    const out = truncateRows(rows, 25, undefined);
    expect(out.truncated).toBe(true);
    expect(out.totalRows).toBeUndefined();
    expect(out.note).toMatch(/did not report a total/i);
  });

  it("resolveLimit falls back to the default for absent or nonsense values", () => {
    expect(resolveLimit(undefined, 25, 100_000)).toBe(25);
    expect(resolveLimit(0, 25, 100_000)).toBe(25);
    expect(resolveLimit(-5, 25, 100_000)).toBe(25);
    expect(resolveLimit(Number.NaN, 25, 100_000)).toBe(25);
    expect(resolveLimit(50, 25, 100_000)).toBe(50);
    expect(resolveLimit(999_999, 25, 100_000)).toBe(100_000);
  });
});

// ------------------------------------------------------- upstream failures

describe("upstream errors surface as typed errors", () => {
  it("maps a 403 quota response from a real tool call", async () => {
    installStubs({ runReport: googleError(403, "quota", "rateLimitExceeded") });
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "ga4_run_report")!;
    await expect(
      tool.handler({ propertyId: "1", startDate: "28daysAgo", endDate: "today", metrics: ["x"] }),
    ).rejects.toMatchObject({ code: "QUOTA" });
  });

  it("maps a 403 permission response from a real tool call", async () => {
    installStubs({ "sites.list": googleError(403, "denied", "forbidden") });
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "gsc_list_sites")!;
    await expect(tool.handler({})).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("wraps upstream failures in GmcpError, never raw", async () => {
    installStubs({ runReport: googleError(500, "boom") });
    const { all } = await buildTools("read");
    const tool = all.find((t) => t.name === "ga4_run_report")!;
    await expect(
      tool.handler({ propertyId: "1", startDate: "28daysAgo", endDate: "today", metrics: ["x"] }),
    ).rejects.toBeInstanceOf(GmcpError);
  });
});
