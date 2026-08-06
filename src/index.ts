#!/usr/bin/env node
/**
 * google-measurement-mcp — server bootstrap.
 *
 * Local stdio MCP server exposing GA4, Search Console, and Tag Manager.
 * Read tools are always registered; write tools appear only when write mode is
 * explicitly enabled (handover D4).
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
import { describeSource, getAuthClient } from "./auth.js";
import { loadConfig } from "./config.js";
import { GmcpError, mapGoogleError } from "./errors.js";
import { createGa4DataTools } from "./tools/ga4-data.js";
import type { ToolDefinition } from "./schemas/index.js";

const PKG_NAME = "google-measurement-mcp";
const PKG_VERSION = "0.1.0";

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

  try {
    const resolved = await getAuthClient(config.mode, config, { interactive: true });
    cached = resolved.client;
    sourceLabel = describeSource(resolved.source);
  } catch (err) {
    // Do not exit. The server still starts so the client can connect and show a
    // useful error on first tool call rather than a bare transport failure.
    const mapped = err instanceof GmcpError ? err : mapGoogleError(err, "resolve Google credentials");
    process.stderr.write(
      `[${PKG_NAME}] Startup authentication failed: ${mapped.message}` +
        (mapped.remedy ? `\n  ${mapped.remedy}\n` : "\n"),
    );
  }

  // Registry. The write-gate branch is in place now so Phase 3 slots in without
  // restructuring, even though no write tools exist yet.
  const readTools: ToolDefinition[] = [...createGa4DataTools(getClient, config)];
  const writeTools: ToolDefinition[] = [];

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
      description: t.description,
      inputSchema: t.inputSchema,
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
