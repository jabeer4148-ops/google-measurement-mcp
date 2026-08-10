/**
 * Credential resolution (handover D2, as amended by docs/GMCP-01a-D2-auth-decision.md).
 *
 * Resolution order:
 *   1. GOOGLE_APPLICATION_CREDENTIALS — service-account JSON. Agency / CI path.
 *   2. Cached user OAuth token — the documented default path for individuals.
 *   3. Application Default Credentials — gcloud users.
 *
 * Scope strings below were verified against live Google documentation on
 * 2026-08-06. Do not edit them from memory; re-verify against the source links.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { AuthMode, Config } from "./config.js";
import { AuthError, PermissionError, mapGoogleError } from "./errors.js";

/** Strip the googleapis auth prefix for human-readable scope lists. */
function shortScope(scope: string): string {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "");
}

/**
 * Return required scopes that are absent from a space-delimited granted list.
 * An empty/missing granted string is treated as granting nothing — safer than
 * assuming an old token file without a `scope` field is fully privileged.
 */
export function missingScopes(granted: string | undefined, required: readonly string[]): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  return required.filter((s) => !have.has(s));
}

/**
 * Verified 2026-08-06.
 *
 * GA4     https://developers.google.com/identity/protocols/oauth2/scopes
 * GSC     https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 * GTM     https://developers.google.com/tag-platform/tag-manager/api/v2/authorization
 *
 * Deliberately NOT requested, per handover D5 (destructive operations are not
 * implemented at all): tagmanager.delete.containers, tagmanager.manage.users,
 * tagmanager.manage.accounts, analytics.manage.users, analytics.provision,
 * analytics.user.deletion.
 */
export const READ_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/tagmanager.readonly",
] as const;

export const WRITE_SCOPES = [
  ...READ_SCOPES,
  "https://www.googleapis.com/auth/analytics.edit",
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  // Required by workspaces.create_version in Phase 3. The handover's §5 scope
  // table omits this entirely — see docs/GMCP-02-phase1.md.
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
  "https://www.googleapis.com/auth/tagmanager.publish",
] as const;

export function scopesFor(mode: AuthMode): string[] {
  return mode === "write" ? [...WRITE_SCOPES] : [...READ_SCOPES];
}

export type CredentialSource = "service_account" | "oauth" | "adc";

export interface ResolvedAuth {
  client: OAuth2Client;
  source: CredentialSource;
  scopes: string[];
}

interface StoredToken {
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

function tokenPath(config: Config): string {
  return join(config.tokenDir, `token-${config.tokenProfile}.json`);
}

async function readStoredToken(config: Config): Promise<StoredToken | undefined> {
  try {
    const raw = await readFile(tokenPath(config), "utf8");
    return JSON.parse(raw) as StoredToken;
  } catch {
    return undefined;
  }
}

/**
 * Persist a refresh token with owner-only permissions.
 *
 * This file is a credential. chmod is a no-op on Windows, where ACL inheritance
 * from the user profile directory provides the equivalent protection.
 */
async function writeStoredToken(config: Config, token: StoredToken): Promise<void> {
  await mkdir(config.tokenDir, { recursive: true, mode: 0o700 });
  const path = tokenPath(config);
  await writeFile(path, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows — ACLs apply instead.
  }
}

async function loadOAuthClientCredentials(
  config: Config,
): Promise<{ clientId: string; clientSecret: string } | undefined> {
  if (config.oauthClientId && config.oauthClientSecret) {
    return { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret };
  }
  if (config.oauthClientJsonPath) {
    try {
      const raw = await readFile(config.oauthClientJsonPath, "utf8");
      const parsed = JSON.parse(raw) as {
        installed?: { client_id?: string; client_secret?: string };
        web?: { client_id?: string; client_secret?: string };
      };
      const block = parsed.installed ?? parsed.web;
      if (block?.client_id && block.client_secret) {
        return { clientId: block.client_id, clientSecret: block.client_secret };
      }
      throw new AuthError(
        `OAuth client JSON at ${config.oauthClientJsonPath} has no usable client_id/client_secret.`,
        "Download a Desktop app OAuth client from the Google Cloud console and point GMCP_OAUTH_CLIENT_JSON at it.",
      );
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError(
        `Could not read the OAuth client JSON at ${config.oauthClientJsonPath}.`,
        "Check the path and that the file is valid JSON.",
      );
    }
  }
  return undefined;
}

/**
 * One-shot desktop loopback consent flow.
 *
 * Binds an ephemeral loopback port, prints the consent URL to stderr (stdout is
 * the MCP transport and must never be polluted), and waits for the redirect.
 */
async function runConsentFlow(
  clientId: string,
  clientSecret: string,
  scopes: string[],
): Promise<{ client: OAuth2Client; tokens: StoredToken }> {
  const { OAuth2Client: Ctor } = await import("google-auth-library");

  return new Promise((resolve, reject) => {
    const server = createServer();

    const timeout = setTimeout(
      () => {
        server.close();
        reject(
          new AuthError(
            "Timed out waiting for Google sign-in (5 minutes).",
            "Re-run and complete the browser consent screen.",
          ),
        );
      },
      5 * 60 * 1000,
    );

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new AuthError(`Could not start the local sign-in listener: ${err.message}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const client = new Ctor({ clientId, clientSecret, redirectUri });

      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: scopes,
      });

      process.stderr.write(
        `\n[google-measurement-mcp] Google sign-in required.\nOpen this URL in your browser:\n\n${authUrl}\n\n`,
      );

      server.on("request", (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", redirectUri);
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          // Ignore stray hits (favicon, prefetch) so they don't abort the flow.
          if (!code && !error) {
            res.writeHead(204);
            res.end();
            return;
          }

          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(
            error
              ? `Sign-in failed: ${error}. You can close this tab.`
              : "Sign-in complete. You can close this tab and return to your terminal.",
          );
          clearTimeout(timeout);
          server.close();

          if (error) {
            reject(new AuthError(`Google sign-in was refused: ${error}`));
            return;
          }

          try {
            const { tokens } = await client.getToken(code!);
            client.setCredentials(tokens);
            if (!tokens.refresh_token) {
              reject(
                new AuthError(
                  "Google returned no refresh token, so the login could not be saved.",
                  "Revoke this app at https://myaccount.google.com/permissions and sign in again — Google only issues a refresh token on first consent.",
                ),
              );
              return;
            }
            resolve({ client, tokens: tokens as StoredToken });
          } catch (err) {
            reject(mapGoogleError(err, "exchange the Google authorization code"));
          }
        })();
      });
    });
  });
}

function describeNoCredentials(mode: AuthMode): AuthError {
  return new AuthError(
    "No Google credentials resolved.",
    [
      "Choose one of three paths:",
      "(1) OAuth, recommended for individuals — set GMCP_OAUTH_CLIENT_ID and GMCP_OAUTH_CLIENT_SECRET (or GMCP_OAUTH_CLIENT_JSON) from a Desktop OAuth client, then run the server once to sign in.",
      "(2) Service account, for agencies and CI — set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key path and grant that email access in GA4, Search Console, and Tag Manager.",
      `(3) gcloud — run: gcloud auth application-default login --scopes=${scopesFor(mode).join(",")}`,
      "See the README for the full setup.",
    ].join(" "),
  );
}

/**
 * Resolve a Google auth client for the requested mode.
 *
 * `interactive` gates the browser consent flow. It must be false when the server
 * is already serving MCP traffic — a consent prompt mid-session would hang the
 * client. Phase 1 runs it during startup only.
 */
export async function getAuthClient(
  mode: AuthMode,
  config: Config,
  opts: { interactive?: boolean } = {},
): Promise<ResolvedAuth> {
  const scopes = scopesFor(mode);
  const interactive = opts.interactive ?? false;

  // 1. Service account.
  if (config.serviceAccountKeyPath) {
    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: config.serviceAccountKeyPath,
        scopes,
      });
      const client = (await auth.getClient()) as OAuth2Client;
      return { client, source: "service_account", scopes };
    } catch (err) {
      throw new AuthError(
        `Could not load the service account key at ${config.serviceAccountKeyPath}.`,
        "Check the path points at a valid service-account JSON key. If your organization blocks service account key creation, use the OAuth path instead — see the README.",
        (err as { code?: number }).code,
      );
    }
  }

  // 2. Cached user OAuth, or a fresh consent flow when interactive.
  const clientCreds = await loadOAuthClientCredentials(config);
  if (clientCreds) {
    const { OAuth2Client: Ctor } = await import("google-auth-library");
    const stored = await readStoredToken(config);

    if (stored?.refresh_token) {
      const client = new Ctor({
        clientId: clientCreds.clientId,
        clientSecret: clientCreds.clientSecret,
      });
      client.setCredentials({ refresh_token: stored.refresh_token });

      // Persist rotated refresh tokens so the cache never goes stale.
      client.on("tokens", (tokens) => {
        if (tokens.refresh_token) {
          void writeStoredToken(config, { ...stored, ...tokens } as StoredToken);
        }
      });

      try {
        await client.getAccessToken();

        // Cached tokens are minted for whatever scopes were granted at consent
        // time. A read-mode login must not silently power write mode — that
        // surfaces later as a confusing Google 403 (GMCP-02 §7.4).
        const shortfall = missingScopes(stored.scope, scopes);
        if (shortfall.length > 0) {
          const missing = shortfall.map(shortScope).join(", ");
          const remedy =
            mode === "write"
              ? "Delete the cached token (or revoke the app at https://myaccount.google.com/permissions), then re-run the server once with --enable-write so the consent screen can grant write scopes."
              : "Delete the cached token and re-run the server once in a terminal to sign in again.";
          throw new PermissionError(
            `Saved Google login is missing required scopes for ${mode} mode: ${missing}.`,
            remedy,
          );
        }

        return { client, source: "oauth", scopes };
      } catch (err) {
        if (err instanceof PermissionError) throw err;
        // Routes invalid_grant to the multi-cause remedy in errors.ts.
        if (!interactive) throw mapGoogleError(err, "refresh your saved Google login");
      }
    }

    if (interactive) {
      const { client, tokens } = await runConsentFlow(
        clientCreds.clientId,
        clientCreds.clientSecret,
        scopes,
      );
      await writeStoredToken(config, tokens);
      return { client, source: "oauth", scopes };
    }

    throw new AuthError(
      "An OAuth client is configured but no saved Google login was found.",
      "Run the server once in a terminal to complete sign-in, then restart your MCP client.",
    );
  }

  // 3. Application Default Credentials.
  try {
    const auth = new google.auth.GoogleAuth({ scopes });
    const client = (await auth.getClient()) as OAuth2Client;
    return { client, source: "adc", scopes };
  } catch {
    throw describeNoCredentials(mode);
  }
}

/** Human-readable label for the startup notice. */
export function describeSource(source: CredentialSource): string {
  switch (source) {
    case "service_account":
      return "service account (GOOGLE_APPLICATION_CREDENTIALS)";
    case "oauth":
      return "user OAuth (cached token)";
    case "adc":
      return "Application Default Credentials";
  }
}
