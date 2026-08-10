#!/usr/bin/env node
/**
 * Proves the D6 confirm gate with a spy — no network, no credentials.
 *
 * This is the single most important assertion in the project. Handover §8 rates
 * "agent publishes a broken GTM container" as the only High-severity risk, and
 * the confirm gate is the control that mitigates it.
 *
 * Asserting on the tool DESCRIPTION is not evidence — a description can promise
 * anything. This stubs the Tag Manager client and asserts on call behaviour:
 * that `versions.publish` is genuinely never invoked without confirm: true.
 *
 * Usage: node scripts/verify-confirm-gate.mjs
 */

import { google } from "googleapis";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ------------------------------------------------------------------- stub
const calls = [];

function makeStub() {
  const track = (label, result) => (args) => {
    calls.push({ label, args });
    return Promise.resolve({ data: result });
  };

  return {
    accounts: {
      containers: {
        versions: {
          get: track("versions.get", {
            path: "accounts/1/containers/2/versions/7",
            containerVersionId: "7",
            name: "candidate version",
            description: "adds checkout tracking",
            tag: [{ name: "Tag A" }, { name: "Tag B" }, { name: "Tag NEW" }],
            trigger: [{ name: "Trigger A" }],
            variable: [{ name: "Var A" }],
          }),
          live: track("versions.live", {
            containerVersionId: "6",
            name: "live version",
            tag: [{ name: "Tag A" }, { name: "Tag B" }, { name: "Tag GONE" }],
            trigger: [{ name: "Trigger A" }],
            variable: [{ name: "Var A" }],
          }),
          publish: track("versions.publish", {
            containerVersion: {
              path: "accounts/1/containers/2/versions/7",
              containerVersionId: "7",
              name: "candidate version",
            },
            compilerError: false,
          }),
        },
      },
    },
  };
}

// Replace the client factory before the tools resolve it. The handlers call
// google.tagmanager() at invocation time, so this substitution takes effect.
google.tagmanager = () => makeStub();

const { createGtmWriteTools } = await import("../dist/tools/gtm-write.js");
const { loadConfig } = await import("../dist/config.js");

const config = loadConfig(["--enable-write"], {});
const tools = createGtmWriteTools(async () => ({}), config);
const publish = tools.find((t) => t.name === "gtm_publish_version");

if (!publish) {
  console.log("[FAIL] gtm_publish_version not found in write tools");
  process.exit(1);
}

const VERSION_PATH = "accounts/1/containers/2/versions/7";

// ----------------------------------------------------- 1. confirm omitted
calls.length = 0;
const omitted = await publish.handler({ versionPath: VERSION_PATH });

record(
  "confirm omitted -> versions.publish NEVER called",
  !calls.some((c) => c.label === "versions.publish"),
  `calls made: [${calls.map((c) => c.label).join(", ")}]`,
);
record("confirm omitted -> published:false", omitted.published === false);
record("confirm omitted -> dryRun:true", omitted.dryRun === true);
record(
  "confirm omitted -> fetches candidate AND live for the diff",
  calls.some((c) => c.label === "versions.get") && calls.some((c) => c.label === "versions.live"),
);
record(
  "dry run reports what would go live",
  omitted.wouldPublish?.containerVersionId === "7" && omitted.wouldPublish?.tagCount === 3,
  `version ${omitted.wouldPublish?.containerVersionId}, ${omitted.wouldPublish?.tagCount} tags`,
);
record(
  "dry run reports the currently live version",
  omitted.currentlyLive?.containerVersionId === "6",
  `live version ${omitted.currentlyLive?.containerVersionId}`,
);
record(
  "dry run computes an accurate delta",
  omitted.delta?.tags?.added?.includes("Tag NEW") &&
    omitted.delta?.tags?.removed?.includes("Tag GONE") &&
    omitted.delta?.tags?.unchangedCount === 2,
  `added=[${omitted.delta?.tags?.added}] removed=[${omitted.delta?.tags?.removed}] unchanged=${omitted.delta?.tags?.unchangedCount}`,
);
record(
  "dry run instructs the agent to seek human approval",
  /human/i.test(omitted.instruction ?? "") && /do not decide this yourself/i.test(omitted.instruction ?? ""),
);

// ------------------------------------------------------- 2. confirm false
calls.length = 0;
const explicitFalse = await publish.handler({ versionPath: VERSION_PATH, confirm: false });
record(
  "confirm:false -> versions.publish NEVER called",
  !calls.some((c) => c.label === "versions.publish"),
  `calls made: [${calls.map((c) => c.label).join(", ")}]`,
);
record("confirm:false -> published:false", explicitFalse.published === false);

// ------------------------------------------- 3. non-boolean confirm values
// A truthy non-boolean must not slip through the gate.
for (const bad of ["true", 1, "yes"]) {
  calls.length = 0;
  let threw = false;
  try {
    await publish.handler({ versionPath: VERSION_PATH, confirm: bad });
  } catch {
    threw = true;
  }
  record(
    `confirm:${JSON.stringify(bad)} (non-boolean) -> rejected or no publish`,
    threw || !calls.some((c) => c.label === "versions.publish"),
    threw ? "rejected by validation" : "no publish call",
  );
}

// -------------------------------------------------------- 4. confirm true
calls.length = 0;
const confirmed = await publish.handler({ versionPath: VERSION_PATH, confirm: true });
record(
  "confirm:true -> versions.publish IS called",
  calls.some((c) => c.label === "versions.publish"),
  `calls made: [${calls.map((c) => c.label).join(", ")}]`,
);
record("confirm:true -> published:true", confirmed.published === true);
record(
  "confirm:true -> returns rollback guidance",
  /roll ?back/i.test(confirmed.note ?? ""),
);

// --------------------------------------------- 5. malformed path rejected
calls.length = 0;
let rejected = false;
try {
  await publish.handler({ versionPath: "accounts/1/containers/2", confirm: true });
} catch (e) {
  rejected = e.code === "VALIDATION";
}
record(
  "malformed versionPath rejected before any API call",
  rejected && calls.length === 0,
  `${calls.length} API calls made`,
);

// ------------------------------------------------------------------ done
const failed = results.filter((r) => !r.ok).length;
console.log("\n" + "=".repeat(60));
console.log(` D6 CONFIRM GATE: ${results.length - failed}/${results.length} passed`);
console.log("=".repeat(60));
process.exit(failed ? 1 : 0);
