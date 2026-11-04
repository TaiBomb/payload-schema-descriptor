import { timingSafeEqual } from "node:crypto";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Endpoint, PayloadRequest, Plugin } from "payload";
import { buildDescriptor, CUSTOM_KEY } from "./buildDescriptor.js";
import type { Descriptor, SchemaDescriptorOptions, StoredOptions } from "./types.js";

export { buildDescriptor, canonicalJSON, hashDescriptor } from "./buildDescriptor.js";
export { DESCRIPTOR_VERSION } from "./types.js";
export type { Descriptor, SchemaDescriptorOptions } from "./types.js";

/** `pnpm payload schema:descriptor [out.json]` */
export const CLI_COMMAND = "schema:descriptor";

// Only the Payload CLI reads this path. Inside the Next bundle it may point
// somewhere odd, which doesn't matter since nothing uses it there.
function exportSchemaScriptPath(): string | undefined {
  try {
    return nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "bin", "exportSchema.js");
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch. Still run a compare so the
  // wrong-length case doesn't return noticeably faster.
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// If-None-Match can be a comma separated list, weak tags (W/"...") or *
function matchesETag(header: string | null, hash: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const t = raw.trim();
    if (t === "*") return true;
    return t.replace(/^W\//, "").replace(/^"|"$/g, "") === hash;
  });
}

/**
 * Serves a JSON description of the schema at `GET /api/_schema`,
 * protected by the `x-internal-api-key` header.
 *
 * Adds an endpoint and a CLI command, and that's it: collections, hooks,
 * access and admin are left untouched.
 */
export const schemaDescriptorPlugin =
  (options: SchemaDescriptorOptions): Plugin =>
  (incoming: Config): Config => {
    const enabled = options.enabled !== false;
    const path = options.path ?? "/_schema";
    const migrations = options.migrations ?? [];
    const stored: StoredOptions = {
      lastMigration: migrations.length > 0 ? migrations[migrations.length - 1].name : null,
      exclude: [...(options.exclude ?? [])],
    };

    // Registered even when disabled: some environments only use the file built in CI.
    const scriptPath = exportSchemaScriptPath();
    const bin = [...(incoming.bin ?? [])];
    if (scriptPath && !bin.some((b) => b.key === CLI_COMMAND)) {
      bin.push({ key: CLI_COMMAND, scriptPath });
    }

    const config: Config = {
      ...incoming,
      bin,
      custom: { ...(incoming.custom ?? {}), [CUSTOM_KEY]: stored },
    };
    if (!enabled) return config;

    if (!options.apiKey) {
      throw new Error("payload-schema-descriptor: `apiKey` is required unless the plugin is disabled");
    }
    const apiKey = options.apiKey;

    // The config can't change while the process is running, so build the
    // descriptor on the first request and keep it. If the DB version came back
    // empty (database was down) drop it, so the next request tries again.
    let cached: Promise<Descriptor> | undefined;
    const getDescriptor = (req: PayloadRequest): Promise<Descriptor> => {
      if (!cached) {
        cached = buildDescriptor(req.payload).then(
          (d) => {
            if (d.db.adapter === "postgres" && d.db.version === null) cached = undefined;
            return d;
          },
          (err) => {
            cached = undefined;
            throw err;
          },
        );
      }
      return cached;
    };

    const endpoint: Endpoint = {
      path,
      method: "get",
      handler: async (req: PayloadRequest): Promise<Response> => {
        const key = req.headers.get("x-internal-api-key");
        if (!key || !safeEqual(key, apiKey)) {
          return new Response(null, { status: 401 });
        }

        const descriptor = await getDescriptor(req);
        const headers = {
          ETag: `"${descriptor.hash}"`,
          "Cache-Control": "no-cache",
        };
        if (matchesETag(req.headers.get("if-none-match"), descriptor.hash)) {
          return new Response(null, { status: 304, headers });
        }
        return Response.json(descriptor, { headers });
      },
    };

    return { ...config, endpoints: [...(config.endpoints ?? []), endpoint] };
  };
