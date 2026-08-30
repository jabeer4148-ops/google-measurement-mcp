/**
 * Identifier normalization.
 *
 * Each of the three APIs names its resources differently, and each accepts more
 * than one surface form. Agents reliably supply whichever form they last saw in a
 * URL or a UI, so normalize rather than reject where the intent is unambiguous.
 */

import { ValidationError } from "../errors.js";

/**
 * Accept `123456789` or `properties/123456789`; the GA4 APIs want the prefixed form.
 *
 * Rejects the `G-XXXXXXX` measurement ID explicitly — it is the single most common
 * confusion, and Google's own 400 for it is unhelpful.
 */
export function normalizePropertyId(raw: string, toolName: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("properties/") ? trimmed.slice("properties/".length) : trimmed;

  if (/^G-/i.test(bare)) {
    throw new ValidationError(
      `${toolName}: "${raw}" is a measurement ID, not a property ID.`,
      "Use the numeric property ID. It appears in any GA4 URL as the digits after 'p' (analytics.google.com/analytics/web/#/a<account>p<property>/), or under GA4 Admin -> Property details -> PROPERTY ID.",
    );
  }
  if (!/^\d+$/.test(bare)) {
    throw new ValidationError(
      `${toolName}: propertyId must be numeric, got "${raw}".`,
      "Call ga4_list_account_summaries to discover valid property IDs.",
    );
  }
  return `properties/${bare}`;
}

/**
 * Accept `123456` or `accounts/123456` for GA4 Admin account resources.
 */
export function normalizeAccountId(raw: string, toolName: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("accounts/") ? trimmed.slice("accounts/".length) : trimmed;
  if (!/^\d+$/.test(bare)) {
    throw new ValidationError(`${toolName}: accountId must be numeric, got "${raw}".`);
  }
  return `accounts/${bare}`;
}

/**
 * Search Console site URLs come in two shapes and they are not interchangeable:
 *   - URL-prefix property: `https://example.com/` (trailing slash significant)
 *   - Domain property:     `sc-domain:example.com`
 *
 * A bare domain is ambiguous, so rather than guessing we reject it and name both
 * options. Guessing wrong yields a 403 that reads like a permissions failure.
 */
export function normalizeSiteUrl(raw: string, toolName: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("sc-domain:")) {
    const domain = trimmed.slice("sc-domain:".length);
    if (!domain) {
      throw new ValidationError(`${toolName}: "sc-domain:" is missing a domain.`);
    }
    return trimmed;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    // URL-prefix properties are registered with a trailing slash; Search Console
    // treats the two forms as different properties.
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }

  throw new ValidationError(
    `${toolName}: siteUrl "${raw}" is ambiguous.`,
    "Use the exact form shown in Search Console: either a URL-prefix property like 'https://example.com/' or a Domain property like 'sc-domain:example.com'. Call gsc_list_sites to see the exact strings your account has access to.",
  );
}

export interface GtmWorkspacePath {
  accountId: string;
  containerId: string;
  workspaceId: string;
  path: string;
}

/**
 * GTM paths are compound: accounts/{a}/containers/{c}/workspaces/{w}.
 *
 * Accept either the full path string or the individual IDs (see docs/DESIGN.md). Callers pass whichever they have; internals always use `path`.
 */
export function normalizeWorkspacePath(
  input: { path?: string; accountId?: string; containerId?: string; workspaceId?: string },
  toolName: string,
): GtmWorkspacePath {
  if (input.path) {
    const m = input.path
      .trim()
      .match(/^accounts\/([^/]+)\/containers\/([^/]+)\/workspaces\/([^/]+)$/);
    if (!m) {
      throw new ValidationError(
        `${toolName}: path "${input.path}" is not a workspace path.`,
        "Expected accounts/{accountId}/containers/{containerId}/workspaces/{workspaceId}, or supply accountId, containerId and workspaceId separately.",
      );
    }
    return { accountId: m[1]!, containerId: m[2]!, workspaceId: m[3]!, path: input.path.trim() };
  }

  const { accountId, containerId, workspaceId } = input;
  if (!accountId || !containerId || !workspaceId) {
    const missing = [
      !accountId && "accountId",
      !containerId && "containerId",
      !workspaceId && "workspaceId",
    ].filter(Boolean);
    throw new ValidationError(
      `${toolName}: missing ${missing.join(", ")}.`,
      "Supply either a full `path`, or all of accountId, containerId and workspaceId. Use gtm_list_workspaces to discover them.",
    );
  }

  return {
    accountId,
    containerId,
    workspaceId,
    path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
  };
}

/** accounts/{a}/containers/{c} — for workspace listing. */
export function normalizeContainerPath(
  input: { path?: string; accountId?: string; containerId?: string },
  toolName: string,
): { accountId: string; containerId: string; path: string } {
  if (input.path) {
    const m = input.path.trim().match(/^accounts\/([^/]+)\/containers\/([^/]+)$/);
    if (!m) {
      throw new ValidationError(
        `${toolName}: path "${input.path}" is not a container path.`,
        "Expected accounts/{accountId}/containers/{containerId}, or supply accountId and containerId separately.",
      );
    }
    return { accountId: m[1]!, containerId: m[2]!, path: input.path.trim() };
  }

  const { accountId, containerId } = input;
  if (!accountId || !containerId) {
    const missing = [!accountId && "accountId", !containerId && "containerId"].filter(Boolean);
    throw new ValidationError(
      `${toolName}: missing ${missing.join(", ")}.`,
      "Supply either a full `path`, or both accountId and containerId. Use gtm_list_containers to discover them.",
    );
  }
  return { accountId, containerId, path: `accounts/${accountId}/containers/${containerId}` };
}

/** accounts/{a} — for container listing. */
export function normalizeGtmAccountPath(raw: string, toolName: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("accounts/")) return trimmed;
  if (!trimmed) throw new ValidationError(`${toolName}: accountId is empty.`);
  return `accounts/${trimmed}`;
}
