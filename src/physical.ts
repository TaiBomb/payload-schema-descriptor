import type { Payload } from "payload";
import type { JSONValue } from "./types.js";

// NOTE: rawTables and tableNameMap are internals of @payloadcms/drizzle, not public API.
// Checked against Payload 3.87. Re-check them whenever Payload is upgraded.

type RawColumn = {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  reference?: { name: string; table: string; onDelete?: string };
  enumName?: string;
  options?: string[];
  locale?: boolean;
};
type RawTable = {
  name: string;
  columns: Record<string, RawColumn>;
  foreignKeys?: Record<string, { columns: string[]; foreignColumns: { name: string; table: string }[] }>;
};

/** Close enough to the `to-snake-case` package drizzle uses for default table names. */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, "$1 $2")
    .replace(/[^a-zA-Z\d]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function sortedObject<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function serializeColumn(c: RawColumn): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = { name: c.name, type: c.type };
  if (c.primaryKey) out.primaryKey = true;
  if (c.notNull) out.notNull = true;
  if (c.type === "enum") {
    if (c.locale) out.locale = true;
    if (c.enumName) out.enumName = c.enumName;
    if (Array.isArray(c.options)) out.options = [...c.options];
  }
  if (c.reference) out.reference = { table: c.reference.table, column: c.reference.name };
  return out;
}

function serializeTable(t: RawTable): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {
    columns: sortedObject(Object.entries(t.columns ?? {}).map(([k, c]) => [k, serializeColumn(c)])),
  };
  const fks = Object.entries(t.foreignKeys ?? {});
  if (fks.length > 0) {
    out.foreignKeys = sortedObject(
      fks.map(([k, fk]) => [
        k,
        {
          columns: [...fk.columns],
          foreignColumns: fk.foreignColumns.map((fc) => ({ table: fc.table, column: fc.name })),
        },
      ]),
    );
  }
  return out;
}

// Each table goes to the collection/global with the longest matching prefix.
// Otherwise excluding `news` would also drop the tables of `news-letters`.
function excludedTables(payload: Payload, tableNames: string[], exclude: Set<string>): Set<string> {
  if (exclude.size === 0) return new Set();
  const db = payload.db as any;
  const map: Map<string, string> = db.tableNameMap;
  const versionsSuffix: string = db.versionsSuffix ?? "_v";

  const roots: Array<{ prefix: string; slug: string }> = [];
  for (const e of [...payload.config.collections, ...payload.config.globals]) {
    const snake = toSnakeCase(e.slug);
    const base = map.get(snake) ?? snake;
    const versions = map.get(`_${snake}${versionsSuffix}`) ?? `_${snake}${versionsSuffix}`;
    roots.push({ prefix: base, slug: e.slug }, { prefix: versions, slug: e.slug });
  }
  roots.sort((a, b) => b.prefix.length - a.prefix.length);

  const out = new Set<string>();
  for (const t of tableNames) {
    const owner = roots.find((r) => t === r.prefix || t.startsWith(`${r.prefix}_`));
    if (owner && exclude.has(owner.slug)) out.add(t);
  }
  return out;
}

function postgresPhysical(payload: Payload, exclude: Set<string>): Record<string, JSONValue> {
  const db = payload.db as any;
  const rawTables: Record<string, RawTable> = db.rawTables ?? {};
  const tableNameMap: Map<string, string> = db.tableNameMap ?? new Map();
  if (!db.rawTables || !db.tableNameMap) {
    throw new Error("payload-schema-descriptor: payload.db.rawTables / tableNameMap not found, unsupported @payloadcms/drizzle version?");
  }

  const drop = excludedTables(payload, Object.keys(rawTables), exclude);
  return {
    tableNameMap: sortedObject([...tableNameMap.entries()].filter(([, v]) => !drop.has(v))),
    tables: sortedObject(
      Object.entries(rawTables)
        .filter(([k]) => !drop.has(k))
        .map(([k, t]) => [k, serializeTable(t)]),
    ),
  };
}

function mongoosePhysical(payload: Payload, exclude: Set<string>): Record<string, JSONValue> {
  // TODO: first pass, not tried against a real Mongo setup yet.
  const db = payload.db as any;
  const collections: Array<[string, string]> = [];
  const versions: Array<[string, string]> = [];
  for (const [slug, model] of Object.entries<any>(db.collections ?? {})) {
    if (exclude.has(slug)) continue;
    const name = model?.collection?.name;
    if (typeof name === "string") collections.push([slug, name]);
  }
  for (const [slug, model] of Object.entries<any>(db.versions ?? {})) {
    if (exclude.has(slug)) continue;
    const name = model?.collection?.name;
    if (typeof name === "string") versions.push([slug, name]);
  }
  const globals = db.globals?.collection?.name;
  return {
    collections: sortedObject(collections),
    versions: sortedObject(versions),
    globals: typeof globals === "string" ? globals : null,
  };
}

export function buildPhysical(payload: Payload, exclude: Set<string>): Record<string, JSONValue> {
  switch (payload.db.name) {
    case "postgres":
    case "sqlite":
      return postgresPhysical(payload, exclude);
    case "mongoose":
      return mongoosePhysical(payload, exclude);
    default:
      return {};
  }
}

/**
 * Database server version. For Postgres we also return server_version_num
 * (e.g. 160004), which is easier to compare than the string.
 * Returns nulls instead of throwing if the database can't be reached.
 */
export async function dbServerVersion(payload: Payload): Promise<{ version: string | null; versionNum: number | null }> {
  const db = payload.db as any;
  try {
    switch (payload.db.name) {
      case "postgres": {
        const res = await db.pool.query(
          "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS num",
        );
        const row = res?.rows?.[0];
        // "16.4 (Debian 16.4-1.pgdg120+2)" -> "16.4"
        const version = typeof row?.version === "string" ? row.version.split(" ")[0] : null;
        return { version, versionNum: typeof row?.num === "number" ? row.num : null };
      }
      case "mongoose": {
        const info = await db.connection?.db?.admin().serverInfo();
        return { version: typeof info?.version === "string" ? info.version : null, versionNum: null };
      }
      default:
        return { version: null, versionNum: null };
    }
  } catch (err) {
    payload.logger?.warn?.({ err }, "payload-schema-descriptor: could not read the database version");
    return { version: null, versionNum: null };
  }
}

export function buildDbOptions(payload: Payload): Record<string, JSONValue> {
  const db = payload.db as any;
  switch (payload.db.name) {
    case "postgres":
    case "sqlite":
      // Only options that change the schema. Don't ever copy pool/connection settings here.
      return {
        schemaName: db.schemaName ?? "public",
        idType: db.idType ?? "serial",
        blocksAsJSON: Boolean(db.blocksAsJSON),
        localesSuffix: db.localesSuffix ?? "_locales",
        relationshipsSuffix: db.relationshipsSuffix ?? "_rels",
        versionsSuffix: db.versionsSuffix ?? "_v",
      };
    default:
      return {};
  }
}
