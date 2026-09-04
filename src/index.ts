#!/usr/bin/env node
/**
 * google-measurement-mcp — server bootstrap.
 *
 * Local stdio MCP server exposing GA4, Search Console, and Tag Manager.
 * Read tools are always registered; write tools appear only when write mode is
 * explicitly enabled (see docs/DESIGN.md).
 *
 * stdout is the MCP transport. All human-facing output goes to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OAuth2Client } from "google-auth-library";
import { describeSource, getAuthClient, scopesFor } from "./auth.js";
import { loadConfig } from "./config.js";
import { GmcpError, mapGoogleError } from "./errors.js";
import { createGa4DataTools } from "./tools/ga4-data.js";
import { createGa4AdminTools } from "./tools/ga4-admin.js";
import { createGscTools } from "./tools/gsc.js";
import { createGtmTools } from "./tools/gtm.js";
import { createGa4AdminWriteTools } from "./tools/ga4-admin-write.js";
import { createGscWriteTools } from "./tools/gsc-write.js";
import { createGtmWriteTools } from "./tools/gtm-write.js";
import type { ToolDefinition } from "./schemas/index.js";

const PKG_NAME = "google-measurement-mcp";
const PKG_VERSION = "0.1.0";

function printUsage(): void {
  process.stdout.write(
    `${PKG_NAME} v${PKG_VERSION}\n\n` +
      "Local stdio MCP server for Google Analytics 4, Search Console, and Tag Manager.\n\n" +
      "Usage:\n" +
      `  ${PKG_NAME} [--enable-write]\n\n` +
      "Options:\n" +
      "  --enable-write  Register the opt-in write tools and request write scopes.\n" +
      "  -h, --help      Show this help.\n" +
      "  -v, --version   Show the installed version.\n",
  );
}

/**
 * Silence gcp-metadata's GCE-residency probe warning.
 *
 * When ADC is attempted off-GCE, google-auth-library pings the metadata server,
 * fails, and emits a MetadataLookupWarning. It is harmless but alarming, and it
 * lands on stderr next to our own diagnostics. Suppressing the specific warning
 * is preferable to setting METADATA_SERVER_DETECTION=none, which would break
 * genuine metadata-based ADC for anyone running this on GCE or Cloud Run.
 */
function suppressMetadataLookupWarning(): void {
  const original = process.emitWarning.bind(process);
  // Signature is heavily overloaded upstream; a permissive wrapper is the
  // pragmatic option here.
  (process as { emitWarning: (...args: never[]) => void }).emitWarning = (
    ...args: never[]
  ): void => {
    const [warning, typeOrOptions] = args as unknown as [
      string | Error,
      (string | { type?: string })?,
    ];
    const name =
      warning instanceof Error
        ? warning.name
        : typeof typeOrOptions === "string"
          ? typeOrOptions
          : typeOrOptions?.type;
    if (name === "MetadataLookupWarning") return;
    (original as (...a: unknown[]) => void)(...(args as unknown[]));
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${PKG_VERSION}\n`);
    return;
  }

  suppressMetadataLookupWarning();
  const config = loadConfig();

  // Resolve credentials once at startup. Interactive is true here and only here:
  // a consent prompt raised mid-session would hang the MCP client.
  let cached: OAuth2Client | undefined;
  let sourceLabel = "unresolved";

  const getClient = async (): Promise<OAuth2Client> => {
    if (cached) return cached;
    const resolved = await getAuthClient(config.mode, config, { interactive: false });
    cached = resolved.client;
    return cached;
  };

  let resolvedScopes: string[] = [];

  try {
    const resolved = await getAuthClient(config.mode, config, { interactive: true });
    cached = resolved.client;
    sourceLabel = describeSource(resolved.source);
    resolvedScopes = resolved.scopes;
  } catch (err) {
    // Do not exit. The server still starts so the client can connect and show a
    // useful error on first tool call rather than a bare transport failure.
    const mapped = err instanceof GmcpError ? err : mapGoogleError(err, "resolve Google credentials");
    process.stderr.write(
      `[${PKG_NAME}] Startup authentication failed: ${mapped.message}` +
        (mapped.remedy ? `\n  ${mapped.remedy}\n` : "\n"),
    );
  }

  // Registry. Write tools are constructed only when the flag is on, so a
  // refactor cannot leak them into read mode.
  const readTools: ToolDefinition[] = [
    ...createGa4DataTools(getClient, config),
    ...createGa4AdminTools(getClient, config),
    ...createGscTools(getClient, config),
    ...createGtmTools(getClient, config),
  ];
  // Built only when the flag is on. Constructing them unconditionally would
  // risk a future refactor leaking them into the read registry.
  const writeTools: ToolDefinition[] = config.writeEnabled
    ? [
        ...createGa4AdminWriteTools(getClient, config),
        ...createGscWriteTools(getClient, config),
        ...createGtmWriteTools(getClient, config),
      ]
    : [];

  // Guard against a copy-paste mistake registering the same name twice, and
  // against a write tool being added to the read list by accident.
  const seen = new Set<string>();
  for (const tool of [...readTools, ...writeTools]) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name registered: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  const misfiled = readTools.filter((t) => t.write);
  if (misfiled.length) {
    throw new Error(
      `Tools marked write:true are in the read registry: ${misfiled.map((t) => t.name).join(", ")}`,
    );
  }
  const mislabelled = writeTools.filter((t) => !t.write);
  if (mislabelled.length) {
    throw new Error(
      `Tools in the write registry are not marked write:true: ${mislabelled.map((t) => t.name).join(", ")}`,
    );
  }

  const tools: ToolDefinition[] = config.writeEnabled
    ? [...readTools, ...writeTools]
    : [...readTools];

  const byName = new Map(tools.map((t) => [t.name, t]));

  process.stderr.write(
    `[${PKG_NAME}] v${PKG_VERSION} starting. ` +
      `Credentials: ${sourceLabel}. ` +
      `Mode: ${config.writeEnabled ? "READ+WRITE" : "read-only"}. ` +
      `Tools: ${tools.length}.\n`,
  );

  // Always report the assembled scopes. This is a diagnostic users need when a
  // write call 403s, and it gives the verification harness something to assert
  // on that does not depend on an error path.
  const scopeSuffixes = (resolvedScopes.length ? resolvedScopes : scopesFor(config.mode)).map((s) =>
    s.replace("https://www.googleapis.com/auth/", ""),
  );
  process.stderr.write(
    `[${PKG_NAME}] Scopes (${scopeSuffixes.length}): ${scopeSuffixes.join(" ")}\n`,
  );

  if (config.writeEnabled) {
    process.stderr.write(
      `[${PKG_NAME}] WRITE TOOLS ENABLED: ${
        writeTools.length ? writeTools.map((t) => t.name).join(", ") : "(none implemented yet)"
      }\n`,
    );
  }

  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.annotations.title,
      description: t.description,
      inputSchema: t.inputSchema,
      // All four hints are always emitted as booleans. Clients and directory
      // validators treat a missing or non-boolean value as a defect, and a
      // default tells the caller nothing. See docs/DESIGN.md.
      annotations: {
        title: t.annotations.title,
        readOnlyHint: t.annotations.readOnlyHint,
        destructiveHint: t.annotations.destructiveHint,
        idempotentHint: t.annotations.idempotentHint,
        openWorldHint: t.annotations.openWorldHint,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: {
                  code: "NOT_FOUND",
                  message: `Unknown tool "${request.params.name}".`,
                  remedy: config.writeEnabled
                    ? undefined
                    : "Write tools are hidden because write mode is off. Start the server with --enable-write to expose them.",
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const mapped = err instanceof GmcpError ? err : mapGoogleError(err, `run ${tool.name}`);
      return {
        isError: true,
        content: [
          { type: "text" as const, text: JSON.stringify(mapped.toPayload(), null, 2) },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[${PKG_NAME}] ${signal} received, shutting down.\n`);
    void server.close().finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${PKG_NAME}] Fatal: ${message}\n`);
  process.exit(1);
});
