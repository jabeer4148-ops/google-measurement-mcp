/**
 * Environment and CLI flag parsing.
 *
 * Write mode is opt-in and must be explicit (see docs/DESIGN.md). When it is off, write
 * tools are never registered — they are absent from tools/list, not present-and-erroring.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type AuthMode = "read" | "write";

export interface Config {
  /** True only when --enable-write or GMCP_ENABLE_WRITE=1 was supplied. */
  writeEnabled: boolean;
  /** Auth scope mode derived from writeEnabled. */
  mode: AuthMode;
  /** Default row cap applied by every list/report tool (see docs/DESIGN.md). */
  defaultRowLimit: number;
  /** Hard ceiling a caller may request via an explicit `limit`. */
  maxRowLimit: number;

  /** Path to a service-account JSON key, if the user set one. */
  serviceAccountKeyPath: string | undefined;
  /** OAuth desktop client credentials, if the user configured them. */
  oauthClientId: string | undefined;
  oauthClientSecret: string | undefined;
  /** Path to a downloaded OAuth client JSON, as an alternative to id/secret. */
  oauthClientJsonPath: string | undefined;
  /** Named token profile, so one machine can hold several Google identities. */
  tokenProfile: string;
  /** Directory holding cached OAuth tokens. Never inside the repo or cwd. */
  tokenDir: string;
}

const DEFAULT_ROW_LIMIT = 25;
const MAX_ROW_LIMIT = 100_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function truthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Build config from argv and the environment.
 *
 * @param argv Defaults to process.argv.slice(2). Injectable for tests.
 * @param env  Defaults to process.env. Injectable for tests.
 */
export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const writeEnabled = argv.includes("--enable-write") || truthy(env["GMCP_ENABLE_WRITE"]);

  const tokenProfile = env["GMCP_TOKEN_PROFILE"]?.trim() || "default";

  // XDG-ish location. Deliberately outside the project directory so a cached
  // refresh token can never be picked up by `npm pack` or committed by accident.
  const configHome = env["XDG_CONFIG_HOME"]?.trim() || join(homedir(), ".config");
  const tokenDir = join(configHome, "google-measurement-mcp");

  return {
    writeEnabled,
    mode: writeEnabled ? "write" : "read",
    defaultRowLimit: parsePositiveInt(env["GMCP_DEFAULT_ROW_LIMIT"], DEFAULT_ROW_LIMIT),
    maxRowLimit: MAX_ROW_LIMIT,
    serviceAccountKeyPath: env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim() || undefined,
    oauthClientId: env["GMCP_OAUTH_CLIENT_ID"]?.trim() || undefined,
    oauthClientSecret: env["GMCP_OAUTH_CLIENT_SECRET"]?.trim() || undefined,
    oauthClientJsonPath: env["GMCP_OAUTH_CLIENT_JSON"]?.trim() || undefined,
    tokenProfile,
    tokenDir,
  };
}
