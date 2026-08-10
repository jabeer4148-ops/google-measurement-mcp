/**
 * Shared contract-test scaffolding.
 *
 * Generalizes the stub pattern proven in scripts/verify-confirm-gate.mjs:
 * replace `google.<api>` before the tool factory resolves it, then assert on
 * call behaviour rather than on documentation promises.
 *
 * No network. No credentials. Runs anywhere, including CI.
 */

import { google } from "googleapis";
import { loadConfig, type Config } from "../../src/config.js";
import type { ToolDefinition } from "../../src/schemas/index.js";

export interface RecordedCall {
  api: string;
  method: string;
  args: unknown;
}

/** Every API call the tools attempted during a test. */
export const calls: RecordedCall[] = [];

export function resetCalls(): void {
  calls.length = 0;
}

export function callsTo(method: string): RecordedCall[] {
  return calls.filter((c) => c.method === method);
}

/**
 * Build a recording stub method.
 *
 * @param api     Label for diagnostics, e.g. "tagmanager".
 * @param method  Dotted method path, e.g. "tags.update".
 * @param result  Body to resolve as `{ data: result }`, or an Error to reject.
 */
function stub(api: string, method: string, result: unknown) {
  return (args: unknown) => {
    calls.push({ api, method, args });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ data: result });
  };
}

/**
 * A Google API error shaped the way googleapis surfaces them.
 *
 * Google distinguishes permission denial from quota exhaustion using the same
 * 403 status and different reason codes, so tests must be able to construct both.
 */
export function googleError(
  status: number,
  message: string,
  reason?: string,
): Error & Record<string, unknown> {
  const err = new Error(message) as Error & Record<string, unknown>;
  err["code"] = status;
  err["response"] = {
    status,
    data: {
      error: {
        code: status,
        message,
        errors: reason ? [{ reason, message }] : [],
      },
    },
  };
  return err;
}

/** OAuth token-endpoint failures arrive with a string `error` field. */
export function invalidGrantError(): Error & Record<string, unknown> {
  const err = new Error("invalid_grant") as Error & Record<string, unknown>;
  err["code"] = 400;
  err["response"] = { status: 400, data: { error: "invalid_grant" } };
  return err;
}

// ------------------------------------------------------------------ fixtures

export const GA4_REPORT_RESPONSE = {
  dimensionHeaders: [{ name: "date" }],
  metricHeaders: [{ name: "activeUsers" }],
  rows: [
    { dimensionValues: [{ value: "20260801" }], metricValues: [{ value: "12" }] },
    { dimensionValues: [{ value: "20260802" }], metricValues: [{ value: "34" }] },
  ],
  rowCount: 2,
};

export const GTM_TAG = {
  path: "accounts/1/containers/2/workspaces/3/tags/9",
  tagId: "9",
  name: "Test Tag",
  type: "html",
  firingTriggerId: ["4"],
  blockingTriggerId: ["7"],
  paused: false,
  notes: "original",
  parameter: [
    { type: "template", key: "html", value: "<script>old</script>" },
    { type: "boolean", key: "supportDocumentWrite", value: "false" },
  ],
};

/**
 * Install stubs for all three Google clients.
 *
 * `overrides` replaces individual method results, including with an Error to
 * exercise the failure path.
 */
export function installStubs(overrides: Record<string, unknown> = {}): void {
  const pick = (key: string, fallback: unknown) =>
    key in overrides ? overrides[key] : fallback;

  google.analyticsdata = (() => ({
    properties: {
      runReport: stub("analyticsdata", "runReport", pick("runReport", GA4_REPORT_RESPONSE)),
      runRealtimeReport: stub(
        "analyticsdata",
        "runRealtimeReport",
        pick("runRealtimeReport", GA4_REPORT_RESPONSE),
      ),
    },
  })) as never;

  google.analyticsadmin = (() => ({
    accountSummaries: {
      list: stub("analyticsadmin", "accountSummaries.list", pick("accountSummaries.list", {
        accountSummaries: [
          {
            account: "accounts/11",
            displayName: "Acct",
            propertySummaries: [{ property: "properties/22", displayName: "Prop" }],
          },
        ],
      })),
    },
    properties: {
      customDimensions: {
        list: stub("analyticsadmin", "customDimensions.list", pick("customDimensions.list", { customDimensions: [] })),
        create: stub("analyticsadmin", "customDimensions.create", pick("customDimensions.create", {
          name: "properties/22/customDimensions/1",
          parameterName: "author",
          displayName: "Author",
          scope: "EVENT",
        })),
      },
      keyEvents: {
        list: stub("analyticsadmin", "keyEvents.list", pick("keyEvents.list", { keyEvents: [] })),
        create: stub("analyticsadmin", "keyEvents.create", pick("keyEvents.create", {
          name: "properties/22/keyEvents/1",
          eventName: "purchase",
          countingMethod: "ONCE_PER_EVENT",
        })),
        patch: stub("analyticsadmin", "keyEvents.patch", pick("keyEvents.patch", {
          name: "properties/22/keyEvents/1",
          eventName: "purchase",
          countingMethod: "ONCE_PER_SESSION",
        })),
      },
    },
  })) as never;

  google.searchconsole = (() => ({
    sites: {
      list: stub("searchconsole", "sites.list", pick("sites.list", {
        siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }],
      })),
    },
    searchanalytics: {
      query: stub("searchconsole", "searchanalytics.query", pick("searchanalytics.query", {
        rows: [{ keys: ["shoes"], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }],
      })),
    },
    sitemaps: {
      list: stub("searchconsole", "sitemaps.list", pick("sitemaps.list", { sitemap: [] })),
      submit: stub("searchconsole", "sitemaps.submit", pick("sitemaps.submit", {})),
    },
    urlInspection: {
      index: {
        inspect: stub("searchconsole", "urlInspection.inspect", pick("urlInspection.inspect", {
          inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Indexed" } },
        })),
      },
    },
  })) as never;

  google.tagmanager = (() => ({
    accounts: {
      list: stub("tagmanager", "accounts.list", pick("accounts.list", { account: [] })),
      containers: {
        list: stub("tagmanager", "containers.list", pick("containers.list", { container: [] })),
        versions: {
          get: stub("tagmanager", "versions.get", pick("versions.get", {
            containerVersionId: "7",
            name: "candidate",
            tag: [{ name: "A" }],
            trigger: [],
            variable: [],
          })),
          live: stub("tagmanager", "versions.live", pick("versions.live", {
            containerVersionId: "6",
            name: "live",
            tag: [],
            trigger: [],
            variable: [],
          })),
          publish: stub("tagmanager", "versions.publish", pick("versions.publish", {
            containerVersion: { containerVersionId: "7", name: "candidate" },
          })),
        },
        workspaces: {
          list: stub("tagmanager", "workspaces.list", pick("workspaces.list", { workspace: [] })),
          create_version: stub("tagmanager", "workspaces.create_version", pick("workspaces.create_version", {
            containerVersion: { containerVersionId: "7", name: "v", description: "notes here", tag: [], trigger: [], variable: [] },
          })),
          tags: {
            list: stub("tagmanager", "tags.list", pick("tags.list", { tag: [] })),
            get: stub("tagmanager", "tags.get", pick("tags.get", GTM_TAG)),
            create: stub("tagmanager", "tags.create", pick("tags.create", GTM_TAG)),
            update: stub("tagmanager", "tags.update", pick("tags.update", GTM_TAG)),
          },
          triggers: {
            list: stub("tagmanager", "triggers.list", pick("triggers.list", { trigger: [] })),
            create: stub("tagmanager", "triggers.create", pick("triggers.create", {
              path: "p", triggerId: "5", name: "T", type: "pageview",
            })),
          },
          variables: {
            list: stub("tagmanager", "variables.list", pick("variables.list", { variable: [] })),
          },
        },
      },
    },
  })) as never;
}

/** Build every tool the server registers, in the given mode. */
export async function buildTools(mode: "read" | "write"): Promise<{
  read: ToolDefinition[];
  write: ToolDefinition[];
  all: ToolDefinition[];
  config: Config;
}> {
  const config = loadConfig(mode === "write" ? ["--enable-write"] : [], {});
  const auth = async () => ({}) as never;

  const { createGa4DataTools } = await import("../../src/tools/ga4-data.js");
  const { createGa4AdminTools } = await import("../../src/tools/ga4-admin.js");
  const { createGscTools } = await import("../../src/tools/gsc.js");
  const { createGtmTools } = await import("../../src/tools/gtm.js");
  const { createGa4AdminWriteTools } = await import("../../src/tools/ga4-admin-write.js");
  const { createGscWriteTools } = await import("../../src/tools/gsc-write.js");
  const { createGtmWriteTools } = await import("../../src/tools/gtm-write.js");

  const read = [
    ...createGa4DataTools(auth, config),
    ...createGa4AdminTools(auth, config),
    ...createGscTools(auth, config),
    ...createGtmTools(auth, config),
  ];
  const write = config.writeEnabled
    ? [
        ...createGa4AdminWriteTools(auth, config),
        ...createGscWriteTools(auth, config),
        ...createGtmWriteTools(auth, config),
      ]
    : [];

  return { read, write, all: [...read, ...write], config };
}
