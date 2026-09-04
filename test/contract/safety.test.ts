/**
 * Safety-critical contract tests.
 *
 * These cover the three controls that make this server safe to point an agent
 * at: the publish confirm gate, merge-not-replace on tag updates, and the
 * schema/validator contract that everything else rests on.
 *
 * A failure in this file is a release blocker.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { buildTools, calls, callsTo, installStubs, resetCalls } from "./helpers.js";
import * as phase2Schemas from "../../src/schemas/phase2.js";
import * as phase3Schemas from "../../src/schemas/phase3.js";
import { ga4RunReportSchema } from "../../src/schemas/ga4-run-report.js";

beforeEach(() => {
  resetCalls();
  installStubs();
});

const VERSION_PATH = "accounts/1/containers/2/versions/7";

// ------------------------------------------------- D6 publish confirm gate

describe("gtm_publish_version confirm gate (see docs/DESIGN.md)", () => {
  async function publishTool() {
    const { write } = await buildTools("write");
    return write.find((t) => t.name === "gtm_publish_version")!;
  }

  /**
   * The single most important assertion in the codebase. A bad GTM container
   * publish is the highest-impact failure this server can cause.
   */
  it.each([
    ["omitted", {}],
    ["false", { confirm: false }],
  ])("with confirm %s, versions.publish is NEVER called", async (_label, extra) => {
    const tool = await publishTool();
    resetCalls();
    const out = (await tool.handler({ versionPath: VERSION_PATH, ...extra })) as {
      published: boolean;
      dryRun: boolean;
    };

    expect(callsTo("versions.publish")).toHaveLength(0);
    expect(out.published).toBe(false);
    expect(out.dryRun).toBe(true);
  });

  /**
   * An agent emitting confirm: "true" as a string is a realistic failure mode —
   * LLMs stringify booleans routinely. A truthiness check would have published
   * on all of these.
   */
  it.each([["true"], [1], ["yes"], [{}], [["true"]]])(
    "a truthy non-boolean confirm (%j) never publishes",
    async (badValue) => {
      const tool = await publishTool();
      resetCalls();
      await tool
        .handler({ versionPath: VERSION_PATH, confirm: badValue })
        .catch(() => undefined);
      expect(callsTo("versions.publish")).toHaveLength(0);
    },
  );

  it("the dry run fetches candidate and live to build a real diff", async () => {
    const tool = await publishTool();
    resetCalls();
    await tool.handler({ versionPath: VERSION_PATH });
    expect(callsTo("versions.get")).toHaveLength(1);
    expect(callsTo("versions.live")).toHaveLength(1);
  });

  it("diffs by name, not by count", async () => {
    installStubs({
      "versions.get": { containerVersionId: "7", tag: [{ name: "A" }, { name: "NEW" }], trigger: [], variable: [] },
      "versions.live": { containerVersionId: "6", tag: [{ name: "A" }, { name: "GONE" }], trigger: [], variable: [] },
    });
    const tool = await publishTool();
    const out = (await tool.handler({ versionPath: VERSION_PATH })) as {
      delta: { tags: { added: string[]; removed: string[]; unchangedCount: number } };
    };

    // Counts are identical (2 vs 2). Only a name diff reveals the swap.
    expect(out.delta.tags.added).toContain("NEW");
    expect(out.delta.tags.removed).toContain("GONE");
    expect(out.delta.tags.unchangedCount).toBe(1);
  });

  it("flags a first publish, where an empty diff would be misleading", async () => {
    installStubs({ "versions.live": new Error("no live version") });
    const tool = await publishTool();
    const out = (await tool.handler({ versionPath: VERSION_PATH })) as {
      currentlyLive: unknown;
      delta: { note?: string };
    };
    expect(out.currentlyLive).toBeNull();
    expect(out.delta.note).toMatch(/FIRST publish/i);
  });

  it("publishes only when confirm is exactly true", async () => {
    const tool = await publishTool();
    resetCalls();
    const out = (await tool.handler({ versionPath: VERSION_PATH, confirm: true })) as {
      published: boolean;
      note: string;
    };
    expect(callsTo("versions.publish")).toHaveLength(1);
    expect(out.published).toBe(true);
    expect(out.note).toMatch(/roll ?back/i);
  });

  it("rejects a malformed version path before any API call", async () => {
    const tool = await publishTool();
    resetCalls();
    await expect(
      tool.handler({ versionPath: "accounts/1/containers/2", confirm: true }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------ merge-not-replace on update

describe("gtm_update_tag merges rather than replaces", () => {
  async function updateTool() {
    const { write } = await buildTools("write");
    return write.find((t) => t.name === "gtm_update_tag")!;
  }
  const TAG_PATH = "accounts/1/containers/2/workspaces/3/tags/9";

  function lastUpdateBody(): Record<string, unknown> {
    const call = callsTo("tags.update").at(-1)!;
    return (call.args as { requestBody: Record<string, unknown> }).requestBody;
  }

  /**
   * The raw GTM API clears omitted fields. A tag with an emptied
   * firingTriggerId looks completely normal in the UI and never fires —
   * silent, severe, and invisible where a human would look. See docs/API-NOTES.md.
   */
  it("preserves omitted firingTriggerId instead of clearing it", async () => {
    const tool = await updateTool();
    resetCalls();
    await tool.handler({ tagPath: TAG_PATH, name: "Renamed", type: "html" });
    expect(lastUpdateBody()["firingTriggerId"]).toEqual(["4"]);
  });

  it("preserves every other omitted field", async () => {
    const tool = await updateTool();
    resetCalls();
    await tool.handler({ tagPath: TAG_PATH, name: "Renamed", type: "html" });
    const body = lastUpdateBody();
    expect(body["blockingTriggerId"]).toEqual(["7"]);
    expect(body["notes"]).toBe("original");
    expect(body["paused"]).toBe(false);
  });

  it("still allows deliberate clearing via an explicit empty array", async () => {
    const tool = await updateTool();
    resetCalls();
    await tool.handler({ tagPath: TAG_PATH, name: "X", type: "html", firingTriggerId: [] });
    expect(lastUpdateBody()["firingTriggerId"]).toEqual([]);
  });

  it("merges parameters by key so one can change without wiping the rest", async () => {
    const tool = await updateTool();
    resetCalls();
    await tool.handler({
      tagPath: TAG_PATH,
      name: "X",
      type: "html",
      parameter: [{ type: "template", key: "html", value: "<script>NEW</script>" }],
    });
    const params = lastUpdateBody()["parameter"] as Array<{ key: string; value: string }>;
    expect(params.find((p) => p.key === "html")!.value).toBe("<script>NEW</script>");
    expect(params.find((p) => p.key === "supportDocumentWrite")).toBeDefined();
  });

  it("reads the current tag before writing", async () => {
    const tool = await updateTool();
    resetCalls();
    await tool.handler({ tagPath: TAG_PATH, name: "X", type: "html" });
    expect(calls[0]!.method).toBe("tags.get");
    expect(callsTo("tags.update")).toHaveLength(1);
  });

  it("reports which fields were preserved", async () => {
    const tool = await updateTool();
    const out = (await tool.handler({ tagPath: TAG_PATH, name: "X", type: "html" })) as {
      preservedFields: string[];
    };
    expect(out.preservedFields).toContain("firingTriggerId");
  });
});

// --------------------------------------------- schema / validator contract

describe("schema and validator stay in contract", () => {
  const allSchemas = Object.entries({
    ga4RunReportSchema,
    ...phase2Schemas,
    ...phase3Schemas,
  }).filter(([, v]) => v && typeof v === "object" && "type" in (v as object)) as Array<
    [string, Record<string, unknown>]
  >;

  /**
   * The hand-rolled validator silently IGNORES keywords
   * it does not implement, so a schema using `oneOf` or `pattern` would look
   * enforced and not be. This catches that at test time.
   */
  const SUPPORTED = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "minItems",
    "minimum",
    "maximum",
    "items",
    "description",
  ]);

  it("no schema uses a JSON Schema keyword the validator does not implement", () => {
    const offenders: string[] = [];
    for (const [name, schema] of allSchemas) {
      for (const key of Object.keys(schema)) {
        if (!SUPPORTED.has(key)) offenders.push(`${name}.${key}`);
      }
      const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const [propName, spec] of Object.entries(props)) {
        for (const key of Object.keys(spec)) {
          if (!SUPPORTED.has(key)) offenders.push(`${name}.${propName}.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every schema is a closed object with descriptions on every property", () => {
    for (const [name, schema] of allSchemas) {
      expect(schema["type"], name).toBe("object");
      expect(schema["additionalProperties"], name).toBe(false);
      const props = (schema["properties"] ?? {}) as Record<string, { description?: string }>;
      for (const [propName, spec] of Object.entries(props)) {
        expect(spec.description, `${name}.${propName} needs a description`).toBeTruthy();
      }
    }
  });

  it("every registered tool references a schema object, not an inline shape", async () => {
    const { all } = await buildTools("write");
    for (const tool of all) {
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect((tool.inputSchema as { type?: string }).type, tool.name).toBe("object");
    }
  });

  /**
   * MCP annotation completeness.
   *
   * A missing or non-boolean hint is treated as a defect by directory
   * validators, and tells a calling client nothing. All four are set
   * explicitly on every tool rather than relying on spec defaults.
   */
  it("every tool sets all four MCP hints as actual booleans", async () => {
    const { all } = await buildTools("write");
    const hints = [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const;

    for (const tool of all) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeTruthy();
      expect(typeof tool.annotations.title, `${tool.name} title`).toBe("string");
      expect(tool.annotations.title.length, `${tool.name} title is empty`).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(
          typeof tool.annotations[hint],
          `${tool.name}.${hint} must be boolean, got ${typeof tool.annotations[hint]}`,
        ).toBe("boolean");
      }
    }
  });

  it("annotations agree with the write flag", async () => {
    const { read, write } = await buildTools("write");

    for (const tool of read) {
      expect(tool.annotations.readOnlyHint, `${tool.name} is a read tool`).toBe(true);
      // A read tool cannot destroy anything and is inherently repeatable.
      expect(tool.annotations.destructiveHint, `${tool.name}`).toBe(false);
      expect(tool.annotations.idempotentHint, `${tool.name}`).toBe(true);
    }

    for (const tool of write) {
      expect(tool.annotations.readOnlyHint, `${tool.name} is a write tool`).toBe(false);
    }
  });

  it("every tool declares openWorldHint true — all of them call a Google API", async () => {
    const { all } = await buildTools("write");
    for (const tool of all) {
      expect(tool.annotations.openWorldHint, tool.name).toBe(true);
    }
  });

  /**
   * The publish tool replaces what is live and is the highest-impact call in
   * the server. If this ever reads non-destructive, a client would stop
   * prompting for it.
   */
  it("gtm_publish_version is annotated destructive", async () => {
    const { write } = await buildTools("write");
    const publish = write.find((t) => t.name === "gtm_publish_version")!;
    expect(publish.annotations.destructiveHint).toBe(true);
  });

  it("create-style tools are annotated non-idempotent", async () => {
    const { write } = await buildTools("write");
    for (const name of ["gtm_create_tag", "gtm_create_trigger", "gtm_create_version"]) {
      const tool = write.find((t) => t.name === name)!;
      // Calling create twice yields two objects, not one.
      expect(tool.annotations.idempotentHint, name).toBe(false);
    }
  });

  it("every write tool declares impact and reversibility in its description", async () => {
    const { write } = await buildTools("write");
    for (const tool of write) {
      expect(tool.description, `${tool.name} must open with impact`).toMatch(
        /^(CHANGES|PUBLISHES)/,
      );
      expect(tool.description, `${tool.name} must state reversibility`).toMatch(
        /REVERSIBLE|NOT REVERSIBLE|SAFE/i,
      );
    }
  });
});
