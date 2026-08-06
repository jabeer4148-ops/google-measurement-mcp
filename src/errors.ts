/**
 * Error taxonomy (handover D8).
 *
 * Nothing from googleapis reaches an MCP client unmapped. Raw stack traces are
 * never surfaced — every failure becomes one of these typed errors with an
 * actionable message.
 */

export type ErrorCode =
  | "AUTH"
  | "PERMISSION"
  | "QUOTA"
  | "NOT_FOUND"
  | "VALIDATION"
  | "UPSTREAM";

export class GmcpError extends Error {
  readonly code: ErrorCode;
  /** Optional operator-facing next step. Shown to the calling agent. */
  readonly remedy: string | undefined;
  /** HTTP status from Google, when the failure originated upstream. */
  readonly httpStatus: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { remedy?: string; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.remedy = opts.remedy;
    this.httpStatus = opts.httpStatus;
  }

  /** Structured payload returned to the MCP client. Never includes a stack. */
  toPayload(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.remedy ? { remedy: this.remedy } : {}),
        ...(this.httpStatus ? { httpStatus: this.httpStatus } : {}),
      },
    };
  }
}

export class AuthError extends GmcpError {
  constructor(message: string, remedy?: string, httpStatus?: number) {
    super("AUTH", message, { remedy, httpStatus });
  }
}
export class PermissionError extends GmcpError {
  constructor(message: string, remedy?: string, httpStatus?: number) {
    super("PERMISSION", message, { remedy, httpStatus });
  }
}
export class QuotaError extends GmcpError {
  constructor(message: string, remedy?: string, httpStatus?: number) {
    super("QUOTA", message, { remedy, httpStatus });
  }
}
export class NotFoundError extends GmcpError {
  constructor(message: string, remedy?: string, httpStatus?: number) {
    super("NOT_FOUND", message, { remedy, httpStatus });
  }
}
export class ValidationError extends GmcpError {
  constructor(message: string, remedy?: string) {
    super("VALIDATION", message, { remedy });
  }
}
export class UpstreamError extends GmcpError {
  constructor(message: string, remedy?: string, httpStatus?: number) {
    super("UPSTREAM", message, { remedy, httpStatus });
  }
}

/**
 * The single most likely support issue created by defaulting to OAuth
 * (GMCP-01a §6.2). Google returns a bare `invalid_grant` for several distinct
 * causes, so name all of them rather than emitting a generic auth failure.
 *
 * Causes, in rough order of likelihood for this tool:
 *  1. Consent screen left in "Testing" — refresh tokens expire after 7 days.
 *  2. Refresh token limit exceeded — 25 per client-ID/account pair; the oldest
 *     is invalidated when the 26th is issued (documented in Google's GTM API
 *     authorization guide).
 *  3. Local clock out of sync with NTP.
 *  4. The user revoked access from their Google account page.
 */
export const INVALID_GRANT_REMEDY = [
  "Your saved Google login is no longer valid. Most likely causes, in order:",
  "1. Your OAuth consent screen is still in 'Testing' status, which expires refresh tokens after 7 days. Set it to 'In Production' in the Google Cloud console, then re-authenticate.",
  "2. You have more than 25 saved logins for this OAuth client; older ones are invalidated automatically.",
  "3. This machine's clock is out of sync.",
  "4. Access was revoked from your Google account page.",
  "Re-run authentication after addressing the cause.",
].join(" ");

interface GoogleErrorShape {
  code?: number;
  status?: number;
  message?: string;
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            code?: number;
            message?: string;
            status?: string;
            errors?: Array<{ reason?: string; message?: string; domain?: string }>;
          };
      error_description?: string;
    };
  };
  errors?: Array<{ reason?: string; message?: string }>;
}

/** Reason codes Google uses for quota exhaustion rather than permission denial. */
const QUOTA_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "concurrentLimitExceeded",
]);

/** Reason codes that genuinely mean "you are not allowed", not "you asked too often". */
const PERMISSION_REASONS = new Set([
  "forbidden",
  "insufficientPermissions",
  "accessNotConfigured",
  "permissionDenied",
  "authError",
]);

function extractReasons(e: GoogleErrorShape): string[] {
  const out: string[] = [];
  const dataError = e.response?.data?.error;
  if (dataError && typeof dataError === "object" && Array.isArray(dataError.errors)) {
    for (const item of dataError.errors) if (item.reason) out.push(item.reason);
  }
  if (Array.isArray(e.errors)) {
    for (const item of e.errors) if (item.reason) out.push(item.reason);
  }
  return out;
}

function extractMessage(e: GoogleErrorShape, fallback: string): string {
  const dataError = e.response?.data?.error;
  if (typeof dataError === "string") return dataError;
  if (dataError && typeof dataError === "object" && dataError.message) return dataError.message;
  if (e.message) return e.message;
  return fallback;
}

/**
 * Map anything thrown by googleapis into the taxonomy.
 *
 * Google signals permission denial and quota exhaustion with the *same* 403
 * status and distinguishes them only by reason code, so 403 is routed on reason
 * rather than status (handover Phase 1 requirement 6).
 *
 * @param err     The caught value. Untyped by necessity.
 * @param context Short description of the attempted operation, e.g. "run GA4 report".
 */
export function mapGoogleError(err: unknown, context: string): GmcpError {
  if (err instanceof GmcpError) return err;

  const e = (err ?? {}) as GoogleErrorShape;
  const status = e.response?.status ?? e.code ?? e.status;
  const rawMessage = extractMessage(e, `Unknown failure while attempting to ${context}.`);
  const reasons = extractReasons(e);

  // invalid_grant arrives as an OAuth token-endpoint failure, often as a 400.
  const dataError = e.response?.data?.error;
  const oauthError = typeof dataError === "string" ? dataError : undefined;
  if (oauthError === "invalid_grant" || /invalid_grant/i.test(rawMessage)) {
    return new AuthError(
      `Authentication failed while attempting to ${context}: the saved credentials were rejected.`,
      INVALID_GRANT_REMEDY,
      typeof status === "number" ? status : undefined,
    );
  }

  switch (status) {
    case 400:
      return new ValidationError(
        `Google rejected the request while attempting to ${context}: ${rawMessage}`,
        "Check the parameter values against the tool's schema.",
      );

    case 401:
      return new AuthError(
        `Not authenticated while attempting to ${context}: ${rawMessage}`,
        "Credentials are missing, expired, or lack the required scope. Re-authenticate, and if you enabled write mode confirm the write scopes were granted.",
        401,
      );

    case 403: {
      if (reasons.some((r) => QUOTA_REASONS.has(r))) {
        return new QuotaError(
          `Google quota exhausted while attempting to ${context}: ${rawMessage}`,
          "Wait and retry with backoff. Search Console URL Inspection is capped at 2,000/day and 600/minute per property; the Tag Manager API has strict per-user limits.",
          403,
        );
      }
      if (reasons.some((r) => PERMISSION_REASONS.has(r)) || reasons.length === 0) {
        return new PermissionError(
          `Permission denied while attempting to ${context}: ${rawMessage}`,
          "The authenticated identity lacks access to this resource, or the required API is not enabled in your Google Cloud project.",
          403,
        );
      }
      return new PermissionError(
        `Access refused while attempting to ${context}: ${rawMessage}`,
        `Google reason code(s): ${reasons.join(", ")}.`,
        403,
      );
    }

    case 404:
      return new NotFoundError(
        `Not found while attempting to ${context}: ${rawMessage}`,
        "Check the identifier. Property, site, and container IDs are easy to transpose — use the corresponding list tool to discover valid values.",
        404,
      );

    case 429:
      return new QuotaError(
        `Rate limited while attempting to ${context}: ${rawMessage}`,
        "Retry with exponential backoff.",
        429,
      );

    default: {
      const numeric = typeof status === "number" ? status : undefined;
      if (numeric !== undefined && numeric >= 500) {
        return new UpstreamError(
          `Google returned a server error while attempting to ${context}: ${rawMessage}`,
          "This is upstream and usually transient. Retry with backoff.",
          numeric,
        );
      }
      return new UpstreamError(
        `Unexpected failure while attempting to ${context}: ${rawMessage}`,
        undefined,
        numeric,
      );
    }
  }
}
