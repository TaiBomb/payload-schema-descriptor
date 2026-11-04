/**
 * Bump this only for breaking changes to the format. Adding a key is not a
 * breaking change, readers are expected to ignore keys they don't know.
 */
export const DESCRIPTOR_VERSION = 1;

export type SchemaDescriptorOptions = {
  /** Set to false to skip the endpoint. The CLI command is still registered. Defaults to true. */
  enabled?: boolean;
  /** Compared against the `x-internal-api-key` header. Required when enabled. */
  apiKey?: string;
  /** Endpoint path, mounted under `routes.api`. Defaults to `/_schema`. */
  path?: string;
  /** The array you pass to `prodMigrations`. Only used to fill in `lastMigration`. */
  migrations?: ReadonlyArray<{ name: string }>;
  /** Collection or global slugs to leave out of the descriptor. */
  exclude?: string[];
};

/** What the plugin stashes in `config.custom`, so the CLI sees the same options as the endpoint. */
export type StoredOptions = {
  lastMigration: string | null;
  exclude: string[];
};

export type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue };

export type FieldDescriptor = {
  name: string;
  type: string;
  [key: string]: unknown;
};

export type BlockDescriptor = {
  slug: string;
  dbName?: string;
  fields: FieldDescriptor[];
};

export type EntityDescriptor = {
  slug: string;
  dbName: string | null;
  fields: FieldDescriptor[];
  [key: string]: unknown;
};

export type Descriptor = {
  descriptorVersion: number;
  payloadVersion: string | null;
  generatedAt: string;
  hash: string;
  lastMigration: string | null;
  /** version / versionNum are null when the database couldn't be queried. */
  db: { adapter: string; version: string | null; versionNum: number | null; options: Record<string, JSONValue> };
  localization: { locales: string[]; defaultLocale: string; fallback: boolean; [k: string]: JSONValue } | null;
  collections: EntityDescriptor[];
  globals: EntityDescriptor[];
  physical: Record<string, JSONValue>;
};
