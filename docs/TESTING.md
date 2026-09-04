# Testing and traceability

**78 contract tests** across 3 files, plus **17 standalone assertions** on the publish confirm gate. No network, no credentials, runs anywhere including CI.

Every tool has at least one covering test.

```bash
npm test                              # 78 contract tests
node scripts/verify-confirm-gate.mjs  # 17 confirm-gate assertions
```

---

## 1. How the tests work

Contract tests stub `google.<api>` before the tool factories resolve it, then assert on **call behaviour** rather than on return values alone.

That distinction is the point. A tool description can promise anything; a test that only checks the returned object cannot tell whether a network request was made first. Several assertions here spy on the stub specifically to prove an API call did *not* happen.

`scripts/verify-confirm-gate.mjs` uses the same stub technique but runs standalone under plain Node, with no test runner. It is the one check that should be runnable by anyone evaluating whether this server is safe to point at their container.

---

## 2. Read tools (15)

| Tool | API | Method | Scope | Quota notes |
|---|---|---|---|---|
| `ga4_run_report` | analyticsdata v1beta | `properties.runReport` | `analytics.readonly` | GA4 token/QPS quotas |
| `ga4_run_realtime_report` | analyticsdata v1beta | `properties.runRealtimeReport` | `analytics.readonly` | ~30 min window |
| `ga4_list_account_summaries` | analyticsadmin v1beta | `accountSummaries.list` | `analytics.readonly` | — |
| `ga4_list_custom_dimensions` | analyticsadmin v1beta | `properties.customDimensions.list` | `analytics.readonly` | — |
| `ga4_list_key_events` | analyticsadmin v1beta | `properties.keyEvents.list` | `analytics.readonly` | — |
| `gsc_list_sites` | searchconsole v1 | `sites.list` | `webmasters.readonly` | — |
| `gsc_search_analytics_query` | searchconsole v1 | `searchanalytics.query` | `webmasters.readonly` | rowLimit 1–25,000 |
| `gsc_list_sitemaps` | searchconsole v1 | `sitemaps.list` | `webmasters.readonly` | — |
| `gsc_inspect_url` | searchconsole v1 | `urlInspection.index.inspect` | `webmasters.readonly` | **2,000/day, 600/min per property** |
| `gtm_list_accounts` | tagmanager v2 | `accounts.list` | `tagmanager.readonly` | strict per-user limits |
| `gtm_list_containers` | tagmanager v2 | `accounts.containers.list` | `tagmanager.readonly` | strict per-user limits |
| `gtm_list_workspaces` | tagmanager v2 | `…workspaces.list` | `tagmanager.readonly` | strict per-user limits |
| `gtm_list_tags` | tagmanager v2 | `…workspaces.tags.list` | `tagmanager.readonly` | strict per-user limits |
| `gtm_list_triggers` | tagmanager v2 | `…workspaces.triggers.list` | `tagmanager.readonly` | strict per-user limits |
| `gtm_list_variables` | tagmanager v2 | `…workspaces.variables.list` | `tagmanager.readonly` | strict per-user limits |

## 3. Write tools (9) — only with `--enable-write`

| Tool | API | Method | Scope | Reversible |
|---|---|---|---|---|
| `ga4_create_custom_dimension` | analyticsadmin v1beta | `properties.customDimensions.create` | `analytics.edit` | **No** — archive-only, permanent slot |
| `ga4_create_key_event` | analyticsadmin v1beta | `properties.keyEvents.create` | `analytics.edit` | Yes, from the GA4 UI |
| `ga4_update_key_event` | analyticsadmin v1beta | `properties.keyEvents.patch` | `analytics.edit` | Yes |
| `gsc_submit_sitemap` | searchconsole v1 | `sitemaps.submit` | `webmasters` | Yes, from the GSC UI |
| `gtm_create_tag` | tagmanager v2 | `…workspaces.tags.create` | `tagmanager.edit.containers` | Yes — workspace-only |
| `gtm_update_tag` | tagmanager v2 | `…tags.get` + `…tags.update` | `tagmanager.edit.containers` | Yes — merges, see [DESIGN.md](DESIGN.md) |
| `gtm_create_trigger` | tagmanager v2 | `…workspaces.triggers.create` | `tagmanager.edit.containers` | Yes — workspace-only |
| `gtm_create_version` | tagmanager v2 | `…workspaces.create_version` | `tagmanager.edit.containerversions` | Safe — creating ≠ publishing |
| `gtm_publish_version` | tagmanager v2 | `…versions.get` / `.live` / `.publish` | `tagmanager.publish` | Yes — via version history |

---

## 4. Safety controls and their evidence

| Control | Evidence |
|---|---|
| Write tools hidden unless flagged | Zero write tools registered with the flag off, asserted by explicit name list |
| Destructive operations not implemented | 10 forbidden tool names asserted absent in **both** modes |
| Destructive scopes never requested | Scope assembly asserted against an explicit forbidden list |
| Read mode requests no write scopes | Asserted — no `.edit`, `.publish` or bare `webmasters` in read mode |
| Publish requires confirmation | `versions.publish` never invoked without `confirm === true`, proven by spy |
| Truthy non-booleans cannot publish | `"true"`, `1`, `"yes"`, `{}`, `["true"]` all fail to publish |
| Diff is by name, not count | Asserted against equal-count collections containing a swap |
| Tag updates cannot silently unwire a tag | Omitted `firingTriggerId` asserted preserved; explicit `[]` asserted to clear |
| Row caps protect the context window | Truncation returns exactly `limit` rows with correct `totalRows` |
| Unknown totals are not invented | Asserted that an unreported total stays `undefined` rather than reporting the over-fetch count |
| Typed errors, never stack traces | Every mapped error asserted free of `at `, `.ts:` and `node_modules` |
| Invalid input never reaches Google | 12 malformed inputs, each asserting **zero** API calls |
| Schemas stay within the validator's subset | Fails if any schema uses a keyword the validator does not implement |

### 4.1 Why the schema-keyword check exists

Validation is driven by a small hand-written validator rather than a JSON Schema library, because the dependency surface is deliberately minimal.

The risk that creates is specific: a hand-rolled validator **silently ignores keywords it does not implement**. A schema using `oneOf` or `pattern` would appear enforced and would not be — a failure with no symptom until something malformed reaches Google.

The mitigation is a test that walks every schema and fails if any key falls outside the implemented subset: `type`, `properties`, `required`, `additionalProperties`, `enum`, `minItems`, `minimum`, `maximum`, `items`, `description`.

Adding a schema feature therefore requires extending the validator first. The test enforces that ordering.

---

## 5. Live smoke tests

`test/smoke/` hits real Google APIs and needs credentials. **Skipped unless `GMCP_SMOKE=1`.** See [test/smoke/README.md](../test/smoke/README.md).

The gate is an environment variable rather than a path exclusion. A plain exclusion would make `vitest run test/smoke` match zero files and report success — a green run that tested nothing, which is worse than no test at all.

Contract tests prove the code is internally consistent. They cannot catch an API that renamed a field or changed a nesting level. That is what smoke tests are for, and why they exist despite being manual.

---

## 6. Known gaps

Stated rather than hidden.

| Gap | Severity | Rationale |
|---|---|---|
| **`ga4_create_custom_dimension` never executed against a live API** | Low | The only irreversible tool; it permanently consumes one of a property's limited dimension slots. **Permanent gap by choice** — there is no good moment to test an irreversible operation on a property anyone cares about. Contract-tested; the request mapping is four scalar fields with no nesting. Anyone wanting live coverage should use a disposable GA4 property. |
| **Service-account auth path not exercised live** | Low–Medium | Six lines of standard `GoogleAuth({ keyFile, scopes })`. Closeable by setting `GOOGLE_APPLICATION_CREDENTIALS`, unsetting the OAuth variables, and running the smoke suite — it prints which credential path resolved. |
| **gcloud ADC path unverified** | Low | Third fallback in the resolution chain, and `gcloud` was not available during development. Closeable by unsetting both other credential sources and running the smoke suite. |
| **`summarizeParameters` untested inside trigger filters** | Low | Proven via tags and variables; only the nested field name within a filter object remains assumed. The empty-collection path is covered. |
| **Write tools verified manually, not automatically** | Low | Exercised against a throwaway GTM container with no snippet installed on any website. Automating writes would mean mutating real configuration on every run. |

---

## 7. Dependency posture

**Runtime dependencies are the only ones that reach users.** The `files` array ships `dist/`, `README.md` and `LICENSE` only — no tests, no scripts, no dev dependencies. A published tarball contains two runtime dependencies: `@modelcontextprotocol/sdk` and `googleapis`.

CI enforces the distinction:

- **Runtime deps** — `npm audit --omit=dev --audit-level=high` **fails the build.**
- **Dev deps** — audited and reported, but non-blocking. A dev-only advisory is not a user-facing vulnerability, and an unrelated transitive finding should not wedge unrelated work.

Non-blocking is not the same as ignored. A dev-only advisory still affects contributors and CI runners, and is worth fixing on its own timeline.

### 7.1 Vitest — GHSA-5xrq-8626-4rwp

Recorded because the remediation is not the obvious one.

The advisory (CVE-2026-47429, CVSS 9.8) covers arbitrary file read and script execution when the **Vitest UI server** is listening. Affected users are those who explicitly expose the UI to the network with `--api.host`, or who run the Vitest UI or Browser Mode on Windows.

**This project never runs the UI.** The scripts are `vitest run` and `vitest` (watch); neither starts the API server, which requires `--ui` or `--api`. Combined with dev-only scope, user-facing exposure is nil.

**The non-obvious part:** the vulnerable range is `< 3.2.6`, and the 2.x line **ends at 2.1.9 with no patch**. A patch-level bump is impossible — clearing it requires a major upgrade. The dev dependency is therefore pinned at `^3.2.7`.

## 8. CI

`.github/workflows/ci.yml` runs on push and pull request against Node 20 and 22:

1. `tsc --noEmit`
2. `npm run build`
3. `npm test` — contract tests only
4. `node scripts/verify-confirm-gate.mjs`
5. Package-contents check — fails the build if a credential pattern, test file, or script appears in `npm pack` output

Smoke tests are excluded by default, so **CI never touches live Google APIs and needs no credentials.**
