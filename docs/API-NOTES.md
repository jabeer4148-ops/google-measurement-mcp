# Google API notes

Behaviours found while building this server that are either undocumented, easy to miss, or actively misleading. Recorded because each one cost real debugging time, and most would bite anyone working against these APIs.

All verified against live APIs in August 2026. Google changes things — re-verify before relying on any of it.

---

## Tag Manager

### `tags.update` replaces, it does not patch

The most consequential finding here.

Send an update omitting `firingTriggerId` and GTM **clears it**. The result is a tag that:

- appears completely normal in the GTM UI, correctly named, HTML intact
- lists correctly through the API
- **never fires**

No error. No warning. Nothing visually wrong in the place a human would look.

Replacement applies *inside* `parameter` too — resending `parameter` with one key deletes the others. Updating just the HTML of a Custom HTML tag will drop `supportDocumentWrite`.

Verified directly: `firingTriggerId: ["4"]` → `[]`, and `supportDocumentWrite: "false"` → absent, after an update that omitted both.

If you are calling this API directly, read the current tag and resend every field you want to keep. This server does that automatically — see [DESIGN.md §4](./DESIGN.md).

### Type-required parameters cannot be omitted

Separately from the above: omitting `parameter` entirely on a `type: "html"` tag is rejected, not cleared.

```
vendorTemplate.parameter.html: The value must not be empty.
```

So omission cannot be used to probe replace-vs-patch semantics on that tag type — the call fails before the question is asked. Include the required parameter and omit only optional fields to observe the clearing behaviour.

### `create_version` takes `notes` but returns `description`

The request body for `workspaces.create_version` accepts a **`notes`** field. The resulting `ContainerVersion` exposes that same content as **`description`**.

Reading back `version.notes` yields `undefined`. Nothing throws — the field simply looks absent rather than misnamed, which makes it easy to conclude the note wasn't saved. It was.

Caught at compile time by the TypeScript definitions in `googleapis`; a dynamically-typed client would likely ship this.

### Compiler errors arrive as HTTP 200

`workspaces.create_version` returns **200 with `compilerError: true`** in the body when the workspace does not compile. A version can be "successfully created" and be broken.

Check the body, not just the status. Otherwise a broken version proceeds to the publish step looking healthy.

### Containers carry two different IDs

- `containerId` — numeric internal ID. **This is what every API method needs.**
- `publicId` — the `GTM-XXXXXXX` string shown in the UI.

Anyone who has used the GTM UI will reach for `publicId`. It will not work.

### Quotas are strict

The Tag Manager API returns 429 readily and Google's own guidance is to space container-mutating calls minutes apart. Read calls are cheaper but still counted. Do not fan out.

### `variables.list` returns user-defined variables only

Built-in variables are a separate collection. An empty result does not mean the container has no variables.

---

## Search Console

### Dates are `YYYY-MM-DD` only

No relative forms. `28daysAgo` works in GA4 and is rejected here. If you are using both APIs in one codebase, this will be tried and it will fail with an unhelpful 400.

### The default row limit is 1,000 and the ceiling is 25,000

`rowLimit` accepts 1–25,000, defaulting to 1,000. Any client that caps lower should say so explicitly, or callers will reasonably assume they are seeing everything.

### `searchType` is deprecated

Use `type`: `web` (default), `image`, `video`, `news`, `googleNews`, `discover`.

### Paging is an offset, not a page token

`startRow`, not `pageToken`. This differs from GA4 (`offset`) and Tag Manager (`pageToken`) — all three APIs page differently, so a single abstraction across them will fit badly.

### `dataState: "hourly_all"` unlocks an `HOUR` dimension

Newer than most published dimension lists.

### FAQ `searchAppearance` support is being removed

Announced for removal from the API in **August 2026**. Do not build on it.

### `siteUrl` has two non-interchangeable forms

- URL-prefix property: `https://example.com/` — the trailing slash is significant
- Domain property: `sc-domain:example.com`

They are *different properties* with different data. A bare `example.com` is ambiguous, and guessing wrong produces a 403 that reads like a permissions failure, sending you to the wrong place entirely.

### Rows come back positionally

`rows[].keys` is a positional array matching the requested `dimensions` order. Re-attach the names yourself or callers get `keys[0]`.

---

## Google Analytics 4

### The realtime schema is a subset of the standard one

`date`, `sessionSource` and most session-scoped dimensions **do not exist** in `runRealtimeReport` and will error. The failure looks like a client bug rather than an API constraint.

### Reports return parallel arrays

`dimensionValues` and `metricValues` are separate arrays that must be zipped against `dimensionHeaders` / `metricHeaders`. Metric values arrive as strings.

### Field limits worth enforcing locally

Custom dimensions: `displayName` ≤ 82 characters, `description` ≤ 150. `disallowAdsPersonalization` applies to USER-scoped dimensions only. Validating locally gives a message that names the limit instead of an opaque 400.

### Custom dimensions cannot be deleted

Only archived — and an archived dimension **still consumes its slot**. Slots are limited (typically 50 event-scoped, 25 user-scoped). Creating one speculatively is a permanent decision.

### The property ID is not the measurement ID

`G-XXXXXXX` is the measurement ID. The APIs want the numeric property ID, which appears in any GA4 URL as the digits after `p`:

```
analytics.google.com/analytics/web/#/a<account>p<property>/...
```

or under **Admin → Property details → PROPERTY ID**.

---

## OAuth

### Scopes

Verified against Google's live documentation:

| Purpose | Scope |
|---|---|
| GA4 read | `analytics.readonly` |
| GA4 write | `analytics.edit` |
| Search Console read | `webmasters.readonly` |
| Search Console sitemap write | `webmasters` |
| Tag Manager read | `tagmanager.readonly` |
| Tag Manager edit | `tagmanager.edit.containers` |
| **Tag Manager versions** | **`tagmanager.edit.containerversions`** |
| Tag Manager publish | `tagmanager.publish` |

**`tagmanager.edit.containerversions` is the one people miss.** It is required by `workspaces.create_version` and is easy to overlook because `tagmanager.edit.containers` sounds like it should cover it. Without it, version creation fails with a 403 that reads like a user permission problem — an error pointing away from its own cause.

### The 7-day refresh token expiry

A consent screen with **User Type: External** and **Publishing status: Testing** issues refresh tokens that expire after **7 days**.

Moving the consent screen to **In Production** removes the limit. Publishing is **not** the same as passing Google verification — for an app where you are the only user of your own OAuth client, there is no review, no security audit, and no waiting. You click through a one-time "unverified app" warning on your own screen.

Nearly every setup guide for this class of tool covers creating the OAuth client and skips this single console setting, which is why so many of them lead to re-authenticating every week.

If you have a Google Workspace organization, **User Type: Internal** avoids both the warning screen and the expiry entirely.

### `invalid_grant` has four distinct causes

Google returns a bare `invalid_grant` for all of them:

1. Consent screen still in **Testing** — the 7-day expiry above
2. **Refresh token limit exceeded** — 25 per client-ID/account pair; issuing the 26th silently invalidates the 1st
3. **Clock skew** — the machine is out of sync with NTP
4. The user **revoked access** from their Google account page

An error message naming only the first would misdiagnose a meaningful share of real occurrences. A confidently wrong error is worse than a vague one.

### The OAuth app name cannot contain "Google"

Creating a consent screen named `google-measurement-mcp` fails with:

```
The request failed because the app name does not comply with Google's requirements.
```

The message never says why. Google's branding policy prohibits app names that may be confused with Google's brands or that combine Google product names with generic terms.

This applies to the **consent-screen display name only** — it has no bearing on npm package naming, where descriptive naming for compatibility is ordinary nominative use.

### Access is per-product, and splitting across accounts is common

GA4, Search Console and Tag Manager assets frequently live under different Google accounts. The diagnostic tell is a call returning **an empty result rather than a 403** — the request succeeded, the identity simply cannot see anything.

Re-authenticating as the other account usually moves the problem rather than solving it, forfeiting access to whichever APIs currently work. Granting the existing identity access to the missing asset is almost always the better move, and needs no re-authentication since the scopes are already held.
