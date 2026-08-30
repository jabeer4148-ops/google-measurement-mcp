/**
 * Error taxonomy contract tests (see docs/TESTING.md).
 *
 * Google signals permission denial and quota exhaustion with the SAME 403 and
 * distinguishes them only by reason code. Getting that wrong sends a user
 * hunting for a permissions problem that does not exist, so it is tested
 * explicitly in both directions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  GmcpError,
  INVALID_GRANT_REMEDY,
  mapGoogleError,
} from "../../src/errors.js";
import { googleError, invalidGrantError } from "./helpers.js";

describe("mapGoogleError — status routing", () => {
  const cases: Array<[number, string | undefined, string]> = [
    [400, undefined, "VALIDATION"],
    [401, undefined, "AUTH"],
    [403, "forbidden", "PERMISSION"],
    [403, "insufficientPermissions", "PERMISSION"],
    [403, "accessNotConfigured", "PERMISSION"],
    [403, undefined, "PERMISSION"],
    [403, "rateLimitExceeded", "QUOTA"],
    [403, "userRateLimitExceeded", "QUOTA"],
    [403, "quotaExceeded", "QUOTA"],
    [403, "dailyLimitExceeded", "QUOTA"],
    [404, undefined, "NOT_FOUND"],
    [429, undefined, "QUOTA"],
    [500, undefined, "UPSTREAM"],
    [503, undefined, "UPSTREAM"],
  ];

  for (const [status, reason, expected] of cases) {
    it(`${status}${reason ? ` (${reason})` : ""} -> ${expected}`, () => {
      const mapped = mapGoogleError(googleError(status, "boom", reason), "do the thing");
      expect(mapped.code).toBe(expected);
    });
  }

  it("routes 403 quota and 403 permission differently despite identical status", () => {
    const quota = mapGoogleError(googleError(403, "x", "rateLimitExceeded"), "act");
    const perm = mapGoogleError(googleError(403, "x", "forbidden"), "act");
    expect(quota.code).toBe("QUOTA");
    expect(perm.code).toBe("PERMISSION");
    expect(quota.code).not.toBe(perm.code);
  });
});

describe("mapGoogleError — message hygiene", () => {
  const samples = [
    googleError(401, "Request had invalid authentication credentials."),
    googleError(403, "Permission denied", "forbidden"),
    googleError(429, "Too many requests"),
    googleError(500, "Backend error"),
    invalidGrantError(),
  ];

  it("never leaks a stack trace into the message", () => {
    for (const err of samples) {
      const mapped = mapGoogleError(err, "act");
      expect(mapped.message).not.toContain("at ");
      expect(mapped.message).not.toContain(".ts:");
      expect(mapped.message).not.toContain("node_modules");
    }
  });

  it("names the attempted operation so the caller knows what failed", () => {
    const mapped = mapGoogleError(googleError(500, "boom"), "run the GA4 report");
    expect(mapped.message).toContain("run the GA4 report");
  });

  it("serializes to a structured payload with no stack field", () => {
    const payload = mapGoogleError(googleError(404, "nope"), "act").toPayload();
    expect(payload["error"]).toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(payload)).not.toContain("stack");
  });
});

describe("mapGoogleError — invalid_grant", () => {
  it("maps to AUTH", () => {
    expect(mapGoogleError(invalidGrantError(), "refresh").code).toBe("AUTH");
  });

  /**
   * docs/API-NOTES.md: Google returns a bare invalid_grant for four distinct causes.
   * Naming only the Testing-status one would misdiagnose roughly a quarter of
   * real occurrences — a confidently wrong message is worse than a vague one.
   */
  it("names all four documented causes", () => {
    const remedy = mapGoogleError(invalidGrantError(), "refresh").remedy ?? "";
    expect(remedy).toBe(INVALID_GRANT_REMEDY);
    expect(remedy).toMatch(/Testing/i);
    expect(remedy).toMatch(/25/);
    expect(remedy).toMatch(/clock/i);
    expect(remedy).toMatch(/revoked/i);
  });
});

describe("mapGoogleError — passthrough", () => {
  it("does not re-wrap an existing GmcpError", () => {
    const original = new GmcpError("VALIDATION", "already typed");
    expect(mapGoogleError(original, "act")).toBe(original);
  });

  it("handles a non-Error throw without crashing", () => {
    const mapped = mapGoogleError("just a string", "act");
    expect(mapped).toBeInstanceOf(GmcpError);
    expect(mapped.code).toBe("UPSTREAM");
  });

  it("handles null", () => {
    expect(mapGoogleError(null, "act").code).toBe("UPSTREAM");
  });
});
