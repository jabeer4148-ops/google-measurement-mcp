# Live smoke tests

**These hit real Google APIs and require credentials. They are skipped unless `GMCP_SMOKE=1`.**

CI never runs them — `vitest.config.ts` excludes this directory by default, so contributors and pull requests can never touch live data or need a Google account.

## Running

**macOS / Linux**

```bash
export GMCP_SMOKE=1
export GMCP_OAUTH_CLIENT_ID=...                 # or GOOGLE_APPLICATION_CREDENTIALS
export GMCP_OAUTH_CLIENT_SECRET=...
export GMCP_SMOKE_PROPERTY_ID=123456789         # a GA4 property you own
export GMCP_SMOKE_SITE_URL=https://example.com/ # optional
export GMCP_SMOKE_GTM_ACCOUNT_ID=1234567890     # optional

npx vitest run test/smoke
```

**Windows PowerShell**

```powershell
$env:GMCP_SMOKE = "1"
$env:GMCP_OAUTH_CLIENT_ID = "..."
$env:GMCP_OAUTH_CLIENT_SECRET = "..."
$env:GMCP_SMOKE_PROPERTY_ID = "123456789"

npx vitest run test/smoke
```

There is deliberately no `npm run test:smoke` script — a bare `GMCP_SMOKE=1 vitest` fails on Windows, and adding `cross-env` as a dependency for one manual command is not worth it.

Each block skips individually if its variable is unset, so a partial setup still runs what it can. Blocks that need credentials **fail** rather than skip when credentials are absent — a smoke suite that silently passes with no credentials would be worse than useless.

## What these are for

Contract tests prove the code is internally consistent. They cannot catch a Google API that renamed a field, changed a nesting level, or started rejecting a previously-valid request. That is what these are for.

Two gaps recorded in [docs/TESTING.md](../../docs/TESTING.md) §6 live here specifically:

- **The service-account auth path** has never been exercised live. Set `GOOGLE_APPLICATION_CREDENTIALS` (and unset the OAuth vars) to close it.
- **The gcloud ADC path** is unverified. Unset both and rely on ADC to close it.

## What these deliberately do NOT do

**No writes.** Every assertion here is read-only.

Write paths were verified manually against a throwaway GTM container with no snippet installed on any website (see [docs/TESTING.md](../../docs/TESTING.md) §6). Automating writes would mean either mutating real configuration on every run, or maintaining a disposable account — neither is worth it for a suite that runs by hand.

`ga4_create_custom_dimension` is never automated under any circumstances. It is irreversible and permanently consumes one of a property's limited dimension slots.
