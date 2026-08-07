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

const listMsg = read.messages.find((m) => m.id === 2);
if (listMsg?.result?.tools) {
  const names = listMsg.result.tools.map((t) => t.name);
  record("tools/list (read mode)", "PASS", names.join(", "));
  const writeLeak = names.filter((n) => /create|update|publish|submit|delete/.test(n));
  record(
    "no write tools exposed",
    writeLeak.length === 0 ? "PASS" : "FAIL",
    writeLeak.length ? `LEAKED: ${writeLeak.join(", ")}` : "none present, as expected",
  );
} else {
  record("tools/list (read mode)", "FAIL", "no response");
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
console.log("\n--- Write mode (scope assembly only; no writes performed) ---");
const write = await runServer(["--enable-write"], {}, [
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
]);

const writeNotice = write.stderr.split("\n").find((l) => l.includes("WRITE TOOLS ENABLED"));
record("write mode announces itself", writeNotice ? "PASS" : "FAIL", writeNotice?.trim().slice(0, 90) ?? "no stderr notice");

const scopeLine = write.stderr.match(/--scopes=(\S+)/);
if (scopeLine) {
  const scopes = scopeLine[1].split(",");
  const hasVersions = scopes.some((s) => s.includes("tagmanager.edit.containerversions"));
  record(
    "write scopes include containerversions",
    hasVersions ? "PASS" : "FAIL",
    `${scopes.length} scopes assembled`,
  );
} else {
  const wCred = write.stderr.split("\n").find((l) => l.includes("Credentials:"));
  record("write mode credentials", wCred && !wCred.includes("unresolved") ? "PASS" : "SKIP", wCred?.match(/Credentials: ([^.]+)\./)?.[1] ?? "not resolved");
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
