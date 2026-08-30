#!/usr/bin/env node
/**
 * Phase 1 verification harness.
 *
 * Exercises every Phase 1 done-criterion and prints a shareable report.
 *
 * SAFETY: this script never prints tokens, client secrets, private keys, or
 * full account identifiers. Emails and client IDs are partially redacted, and
 * GA4 dimension VALUES are summarized rather than dumped, so the output can be
 * pasted into a chat or an issue without leaking credentials or business data.
 *
 * Usage:
 *   node scripts/verify-phase1.mjs --property 123456789
 *   node scripts/verify-phase1.mjs --property 123456789 --show-rows
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const PROPERTY = arg("property");
const SHOW_ROWS = args.includes("--show-rows");

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Redact all but the leading fragment of a sensitive-ish identifier. */
function redact(value, keep = 6) {
  if (!value) return "(unset)";
  const s = String(value);
  if (s.length <= keep) return `${s[0] ?? ""}***`;
  return `${s.slice(0, keep)}...***(${s.length} chars)`;
}

function redactEmail(email) {
  if (!email || !email.includes("@")) return "(none)";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 3)}***@${domain}`;
}

console.log("=".repeat(64));
console.log(" google-measurement-mcp — Phase 1 verification");
console.log(" Output is redacted and safe to share.");
console.log("=".repeat(64));
console.log();

// ---------------------------------------------------------------- environment
console.log("--- Environment ---");
console.log(`node               ${process.version}`);
console.log(`platform           ${process.platform}`);

const hasOAuthPair = Boolean(
  process.env.GMCP_OAUTH_CLIENT_ID && process.env.GMCP_OAUTH_CLIENT_SECRET,
);
const hasOAuthJson = Boolean(process.env.GMCP_OAUTH_CLIENT_JSON);
const hasSA = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

console.log(`GMCP_OAUTH_CLIENT_ID     ${redact(process.env.GMCP_OAUTH_CLIENT_ID, 12)}`);
console.log(`GMCP_OAUTH_CLIENT_SECRET ${process.env.GMCP_OAUTH_CLIENT_SECRET ? "(set, redacted)" : "(unset)"}`);
console.log(`GMCP_OAUTH_CLIENT_JSON   ${hasOAuthJson ? "(set)" : "(unset)"}`);
console.log(`GOOGLE_APPLICATION_CREDENTIALS ${hasSA ? "(set)" : "(unset)"}`);
console.log(`GMCP_ENABLE_WRITE        ${process.env.GMCP_ENABLE_WRITE ?? "(unset)"}`);
console.log();

// Service account identity — the email is needed to grant access, and knowing
// whether it is present is diagnostic. Redacted regardless.
if (hasSA) {
  try {
    const key = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
    console.log(`service account    ${redactEmail(key.client_email)}`);
    console.log(`  project_id       ${redact(key.project_id, 8)}`);
    console.log(`  has private_key  ${Boolean(key.private_key)}`);
    console.log();
  } catch {
    console.log("service account    (key file unreadable — check the path)\n");
  }
}

// ------------------------------------------------------------------ build check
if (!existsSync(join(process.cwd(), "dist", "index.js"))) {
  record("build present", "FAIL", "dist/index.js missing — run `npm run build` first");
  process.exit(1);
}
record("build present", "PASS", "dist/index.js found");

// ------------------------------------------------------------- token cache check
const tokenDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-measurement-mcp");
const profile = process.env.GMCP_TOKEN_PROFILE || "default";
const tokenFile = join(tokenDir, `token-${profile}.json`);

if (existsSync(tokenFile)) {
  try {
    const t = JSON.parse(readFileSync(tokenFile, "utf8"));
    record(
      "oauth token cached",
      "PASS",
      `has refresh_token: ${Boolean(t.refresh_token)}; scopes recorded: ${t.scope ? t.scope.split(" ").length : 0}`,
    );
  } catch {
    record("oauth token cached", "FAIL", "token file present but unparseable");
  }
} else {
  record("oauth token cached", "SKIP", "no cached token — sign in first if using OAuth");
}

// ----------------------------------------------------- MCP protocol exercise
function runServer(extraArgs, env, requests, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...extraArgs], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verify", version: "1" },
      },
    });

    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (const r of requests) send(r);
    }, 500);

    setTimeout(() => {
      child.kill("SIGINT");
      const messages = [];
      for (const line of out.split("\n").filter(Boolean)) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          /* partial line */
        }
      }
      resolve({ messages, stderr: err });
    }, ms);
  });
}

function parseToolResult(msg) {
  try {
    return JSON.parse(msg.result.content[0].text);
  } catch {
    return undefined;
  }
}

// --- read mode ---
console.log("\n--- Read mode ---");
const read = await runServer([], {}, [
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "ga4_run_report",
      arguments: {
        propertyId: "G-NOTNUMERIC",
        startDate: "2026-01-01",
        endDate: "today",
        metrics: ["activeUsers"],
      },
    },
  },
  ...(PROPERTY
    ? [
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "ga4_run_report",
            arguments: {
              propertyId: PROPERTY,
              startDate: "28daysAgo",
              endDate: "today",
              dimensions: ["date"],
              metrics: ["activeUsers", "sessions"],
              limit: 5,
            },
          },
        },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "ga4_run_report",
            arguments: {
              propertyId: PROPERTY,
              startDate: "365daysAgo",
              endDate: "today",
              dimensions: ["date", "sessionSource"],
              metrics: ["sessions"],
              limit: 3,
            },
          },
        },
      ]
    : []),
]);

const credLine = read.stderr.split("\n").find((l) => l.includes("Credentials:"));
if (credLine) {
  const m = credLine.match(/Credentials: ([^.]+)\./);
  record("credentials resolved", m && !m[1].includes("unresolved") ? "PASS" : "FAIL", m ? m[1] : "unknown");
} else {
  record("credentials resolved", "FAIL", "no startup line captured");
}

const EXPECTED_READ_TOOLS = [
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

const listMsg = read.messages.find((m) => m.id === 2);
if (listMsg?.result?.tools) {
  const tools = listMsg.result.tools;
  const names = tools.map((t) => t.name);

  // Assert by explicit name list, not a count or snapshot. A snapshot silently
  // absorbs a tool that should not be there (docs/TESTING.md lesson).
  const missing = EXPECTED_READ_TOOLS.filter((n) => !names.includes(n));
  const unexpected = names.filter((n) => !EXPECTED_READ_TOOLS.includes(n));
  record(
    "tools/list matches expected read surface",
    missing.length === 0 && unexpected.length === 0 ? "PASS" : "FAIL",
    missing.length || unexpected.length
      ? `missing: [${missing.join(", ")}] unexpected: [${unexpected.join(", ")}]`
      : `all ${names.length} present`,
  );

  const writeLeak = names.filter((n) => /_create|_update|_publish|_submit|_delete|_archive/.test(n));
  record(
    "no write tools exposed",
    writeLeak.length === 0 ? "PASS" : "FAIL",
    writeLeak.length ? `LEAKED: ${writeLeak.join(", ")}` : "none present, as expected",
  );

  // Every tool must ship a usable schema — registration referencing the schema
  // object is the D8 contract, and an empty one silently breaks agent calling.
  const badSchema = tools.filter(
    (t) =>
      !t.inputSchema ||
      t.inputSchema.type !== "object" ||
      typeof t.inputSchema.properties !== "object",
  );
  record(
    "every tool declares an object schema",
    badSchema.length === 0 ? "PASS" : "FAIL",
    badSchema.length ? `bad: ${badSchema.map((t) => t.name).join(", ")}` : `${tools.length} schemas valid`,
  );

  // Descriptions are the agent's only guidance. Empty or terse ones cause
  // mis-calls that look like tool bugs.
  const thin = tools.filter((t) => !t.description || t.description.length < 60);
  record(
    "every tool has a substantive description",
    thin.length === 0 ? "PASS" : "FAIL",
    thin.length ? `thin: ${thin.map((t) => t.name).join(", ")}` : "all >= 60 chars",
  );

  // Tools requiring an identifier should say where to get it.
  const discovery = tools.filter((t) =>
    ["ga4_run_report", "gsc_search_analytics_query", "gtm_list_containers"].includes(t.name),
  );
  const noPointer = discovery.filter(
    (t) => !/ga4_list_account_summaries|gsc_list_sites|gtm_list_accounts|Property details/i.test(t.description),
  );
  record(
    "id-requiring tools point at a discovery tool",
    noPointer.length === 0 ? "PASS" : "FAIL",
    noPointer.length ? `no pointer: ${noPointer.map((t) => t.name).join(", ")}` : "all cross-referenced",
  );
} else {
  record("tools/list matches expected read surface", "FAIL", "no response");
}

const badId = read.messages.find((m) => m.id === 3);
const badIdPayload = badId ? parseToolResult(badId) : undefined;
record(
  "local validation rejects measurement ID",
  badIdPayload?.error?.code === "VALIDATION" ? "PASS" : "FAIL",
  badIdPayload?.error?.code ?? "no response",
);

if (PROPERTY) {
  const live = read.messages.find((m) => m.id === 4);
  const payload = live ? parseToolResult(live) : undefined;

  if (payload?.error) {
    record("LIVE GA4 report", "FAIL", `${payload.error.code}: ${payload.error.message.slice(0, 120)}`);
    if (payload.error.remedy) console.log(`       remedy: ${payload.error.remedy.slice(0, 200)}`);
  } else if (payload?.rows) {
    record(
      "LIVE GA4 report",
      "PASS",
      `${payload.rowCount} rows; metrics=[${payload.metricHeaders?.join(",")}]; dims=[${payload.dimensionHeaders?.join(",")}]`,
    );
    const nonZero = payload.rows.some((r) => Number(r.activeUsers) > 0 || Number(r.sessions) > 0);
    record("live report contains data", nonZero ? "PASS" : "SKIP", nonZero ? "non-zero metrics present" : "all zeros — property may have no recent traffic");
    if (SHOW_ROWS) {
      console.log("       sample rows:", JSON.stringify(payload.rows.slice(0, 3)));
    }
  } else {
    record("LIVE GA4 report", "FAIL", "no parseable response");
  }

  const trunc = read.messages.find((m) => m.id === 5);
  const tPayload = trunc ? parseToolResult(trunc) : undefined;
  if (tPayload?.rows) {
    record(
      "truncation behaviour",
      tPayload.rowCount <= 3 ? "PASS" : "FAIL",
      `returned ${tPayload.rowCount}, truncated=${Boolean(tPayload.truncated)}, totalRows=${tPayload.totalRows ?? "not reported"}`,
    );
  } else if (tPayload?.error) {
    record("truncation behaviour", "SKIP", `upstream error: ${tPayload.error.code}`);
  }
} else {
  record("LIVE GA4 report", "SKIP", "pass --property <numericId> to test");
}

// --- write mode ---
console.log("\n--- Write mode (registration + gating only; NO writes performed) ---");

const EXPECTED_WRITE_TOOLS = [
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

// Deliberately never implemented (see docs/DESIGN.md §2). Asserting their ABSENCE is the
// point — this list must stay in sync with the README's safety section.
const FORBIDDEN_TOOLS = [
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

const write = await runServer(["--enable-write"], {}, [
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
]);

const writeList = write.messages.find((m) => m.id === 2);
if (writeList?.result?.tools) {
  const names = writeList.result.tools.map((t) => t.name);
  const expectedAll = [...EXPECTED_READ_TOOLS, ...EXPECTED_WRITE_TOOLS];

  const missing = expectedAll.filter((n) => !names.includes(n));
  const unexpected = names.filter((n) => !expectedAll.includes(n));
  record(
    "write mode exposes exactly read + write tools",
    missing.length === 0 && unexpected.length === 0 ? "PASS" : "FAIL",
    missing.length || unexpected.length
      ? `missing: [${missing.join(", ")}] unexpected: [${unexpected.join(", ")}]`
      : `${names.length} tools (${EXPECTED_READ_TOOLS.length} read + ${EXPECTED_WRITE_TOOLS.length} write)`,
  );

  const forbidden = FORBIDDEN_TOOLS.filter((n) => names.includes(n));
  record(
    "destructive tools absent even in write mode",
    forbidden.length === 0 ? "PASS" : "FAIL",
    forbidden.length ? `PRESENT: ${forbidden.join(", ")}` : `none of ${FORBIDDEN_TOOLS.length} forbidden names`,
  );

  // Every write tool must declare its impact and reversibility up front, so an
  // agent reading tools/list can weigh the call before making it.
  const writeTools = writeList.result.tools.filter((t) => EXPECTED_WRITE_TOOLS.includes(t.name));
  const noImpact = writeTools.filter(
    (t) => !/^(CHANGES|PUBLISHES)/.test(t.description ?? ""),
  );
  record(
    "write descriptions open with impact",
    noImpact.length === 0 ? "PASS" : "FAIL",
    noImpact.length ? `missing: ${noImpact.map((t) => t.name).join(", ")}` : "all declare CHANGES/PUBLISHES",
  );

  const noReversibility = writeTools.filter(
    (t) => !/REVERSIBLE|NOT REVERSIBLE|SAFE/i.test(t.description ?? ""),
  );
  record(
    "write descriptions state reversibility",
    noReversibility.length === 0 ? "PASS" : "FAIL",
    noReversibility.length ? `missing: ${noReversibility.map((t) => t.name).join(", ")}` : "all state reversibility",
  );

  // The D6 gate, asserted at the schema level.
  const publish = writeTools.find((t) => t.name === "gtm_publish_version");
  const confirmProp = publish?.inputSchema?.properties?.confirm;
  record(
    "gtm_publish_version declares a confirm parameter",
    confirmProp && confirmProp.type === "boolean" ? "PASS" : "FAIL",
    confirmProp ? "boolean confirm present" : "MISSING — the D6 gate is not declared",
  );
  record(
    "gtm_publish_version warns against self-approval",
    /do not set confirm: true on your own initiative/i.test(publish?.description ?? "")
      ? "PASS"
      : "FAIL",
    "description must tell the agent not to self-approve",
  );
} else {
  record("write mode exposes exactly read + write tools", "FAIL", "no response");
}

const writeNotice = write.stderr.split("\n").find((l) => l.includes("WRITE TOOLS ENABLED"));
record("write mode announces itself", writeNotice ? "PASS" : "FAIL", writeNotice?.trim().slice(0, 90) ?? "no stderr notice");

// Assert on the dedicated Scopes: line, which the server always emits.
//
// The earlier version of this check parsed `--scopes=` out of the *failure*
// message, so it silently stopped running once credentials resolved and was
// replaced by a weaker assertion that still reported PASS. Never key a test on
// a string that only appears on an error path.
const writeScopeLine = write.stderr.match(/Scopes \((\d+)\): (.+)/);
if (writeScopeLine) {
  const scopes = writeScopeLine[2].trim().split(/\s+/);
  const required = [
    "analytics.readonly",
    "webmasters.readonly",
    "tagmanager.readonly",
    "analytics.edit",
    "webmasters",
    "tagmanager.edit.containers",
    "tagmanager.edit.containerversions",
    "tagmanager.publish",
  ];
  const missing = required.filter((r) => !scopes.includes(r));
  record(
    "write scopes complete (incl. containerversions)",
    missing.length === 0 ? "PASS" : "FAIL",
    missing.length ? `MISSING: ${missing.join(", ")}` : `all ${scopes.length} present`,
  );

  // Destructive scopes must never be requested, even in write mode (see docs/DESIGN.md §2).
  const forbidden = [
    "tagmanager.delete.containers",
    "tagmanager.manage.users",
    "tagmanager.manage.accounts",
    "analytics.manage.users",
    "analytics.provision",
    "analytics.user.deletion",
  ];
  const leaked = forbidden.filter((f) => scopes.includes(f));
  record(
    "no destructive scopes requested",
    leaked.length === 0 ? "PASS" : "FAIL",
    leaked.length ? `LEAKED: ${leaked.join(", ")}` : "none present, as expected",
  );
} else {
  record("write scopes complete (incl. containerversions)", "FAIL", "no Scopes: line emitted — server may be stale, rebuild");
}

// Read mode must NOT request write scopes.
const readScopeLine = read.stderr.match(/Scopes \((\d+)\): (.+)/);
if (readScopeLine) {
  const scopes = readScopeLine[2].trim().split(/\s+/);
  const writeOnly = scopes.filter((s) => /\.edit|\.publish|^webmasters$/.test(s));
  record(
    "read mode requests no write scopes",
    writeOnly.length === 0 ? "PASS" : "FAIL",
    writeOnly.length ? `LEAKED: ${writeOnly.join(", ")}` : `${scopes.length} read-only scopes`,
  );
} else {
  record("read mode requests no write scopes", "FAIL", "no Scopes: line emitted — rebuild");
}

// Does the cached token actually carry the scopes write mode needs?
// A token minted for read scopes must NOT resolve write mode — §7.4.
if (existsSync(tokenFile)) {
  try {
    const t = JSON.parse(readFileSync(tokenFile, "utf8"));
    const granted = (t.scope ?? "").split(/\s+/).filter(Boolean).map((s) => s.replace("https://www.googleapis.com/auth/", ""));
    const needsForWrite = ["analytics.edit", "tagmanager.publish", "tagmanager.edit.containerversions"];
    const absent = needsForWrite.filter((s) => !granted.includes(s));
    if (absent.length) {
      const rejected = /missing required scopes for write mode/i.test(write.stderr);
      record(
        "write mode rejects underscoped cached token",
        rejected ? "PASS" : "FAIL",
        rejected
          ? `PermissionError raised for missing: ${absent.join(", ")}`
          : "expected PermissionError on write startup with read-only token — rebuild?",
      );
      record(
        "cached token scope coverage",
        "SKIP",
        `read-only token (missing ${absent.length} write scopes) — re-auth with --enable-write before write mode works`,
      );
    } else {
      record("write mode rejects underscoped cached token", "SKIP", "token already carries write scopes");
      record("cached token scope coverage", "PASS", "token carries write scopes");
    }
  } catch {
    /* already reported above */
  }
}

// ------------------------------------------------------------------- summary
console.log("\n" + "=".repeat(64));
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;
console.log(` SUMMARY: ${pass} passed, ${fail} failed, ${skip} skipped`);
console.log("=".repeat(64));

if (fail > 0) {
  console.log("\nFailures:");
  for (const r of results.filter((x) => x.status === "FAIL")) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
}
console.log("\nPaste this entire output back. It contains no secrets.");
