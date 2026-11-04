import type { Payload, SanitizedConfig } from "payload";

/**
 * Bare-bones Payload instance that never touches a database. The adapter's
 * init() is enough to build rawTables/tableNameMap. The pool is a stub that
 * returns a fixed Postgres version, or throws to simulate the DB being down.
 */
export async function offlinePayload(
  config: SanitizedConfig,
  pg: { version: string; num: number } | "down" = { version: "16.4 (Debian 16.4-1.pgdg120+2)", num: 160004 },
): Promise<Payload> {
  const payload: any = {
    config,
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    collections: Object.fromEntries(config.collections.map((c) => [c.slug, { config: c }])),
    globals: { config: config.globals },
    blocks: Object.fromEntries((config.blocks ?? []).map((b) => [b.slug, b])),
  };
  payload.db = config.db.init({ payload });
  await payload.db.init();
  payload.db.pool = {
    query: async () => {
      if (pg === "down") throw new Error("connect ECONNREFUSED");
      return { rows: [{ version: pg.version, num: pg.num }] };
    },
  };
  return payload as Payload;
}

export function findEndpoint(config: SanitizedConfig, path = "/_schema") {
  return config.endpoints && Array.isArray(config.endpoints)
    ? config.endpoints.find((e) => e.path === path && e.method === "get")
    : undefined;
}

export function callEndpoint(config: SanitizedConfig, payload: Payload, headers: Record<string, string>, path?: string) {
  const ep = findEndpoint(config, path);
  if (!ep) throw new Error("endpoint not registered");
  return ep.handler({ payload, headers: new Headers(headers) } as any);
}
