# payload-schema-descriptor

A small Payload 3 plugin that publishes a JSON description of your schema: collections,
fields, locales, a few adapter options and the physical Postgres tables.

We wrote it for `gopcmsdb`, a Go library that reads Payload data straight from the
database instead of going through the REST API. To do that it has to know how the
config maps onto tables (localized fields live in `*_locales`, arrays get their own
table, `hasMany` relationships go to `*_rels`...), and none of that can be reliably
worked out from the database or the public APIs. Payload already has all of it in
memory after startup, so the plugin just serializes it.

It doesn't touch your collections, hooks, access control or admin UI. It adds one
endpoint and one CLI command.

## Install

```bash
pnpm add payload-schema-descriptor
```

`payload` is a peer dependency (`^3`). There are no other runtime dependencies.

```ts
import { schemaDescriptorPlugin } from "payload-schema-descriptor";
import { migrations } from "./migrations";

export default buildConfig({
  // ...
  plugins: [
    schemaDescriptorPlugin({
      apiKey: process.env.INTERNAL_API_KEY!,
      migrations,
    }),
  ],
});
```

Plugin order doesn't matter. The descriptor is built lazily from the final config, so
fields added by other plugins (the multi-tenant `tenant` field, for example) show up too.

### Options

| Option | Type | Default | |
| --- | --- | --- | --- |
| `apiKey` | `string` | | Required unless `enabled` is `false`. Checked against the `x-internal-api-key` header. |
| `migrations` | `{ name: string }[]` | | Same array you pass to `prodMigrations`. Used for `lastMigration`. |
| `exclude` | `string[]` | `[]` | Collection or global slugs to leave out. |
| `path` | `string` | `/_schema` | Mounted under `routes.api`. Only change it if it clashes with a slug. |
| `enabled` | `boolean` | `true` | `false` skips the endpoint. The CLI command still works. |

## The endpoint

```bash
curl -H "x-internal-api-key: $INTERNAL_API_KEY" http://localhost:3000/api/_schema
```

- `200` with the descriptor, plus `ETag: "<hash>"` and `Cache-Control: no-cache`
- `304` if `If-None-Match` matches the current hash
- `401` if the key is missing or wrong (no further detail is given)
- `404` if the plugin is disabled

The descriptor is built on the first request and kept in memory, since the config can't
change while the process is running. Clients are expected to poll with `If-None-Match`,
so most calls end up as cheap 304s.

## CLI

The plugin also registers a Payload CLI command that writes the descriptor to a file.
We use it in CI to ship a fallback copy alongside the services that read it.

```bash
SEED_DB=false pnpm payload schema:descriptor schema.json
```

The output path is the first argument, then `$SCHEMA_OUT`, then `./schema.json`. The file
matches what the endpoint returns, apart from `generatedAt`.

A couple of things to keep in mind:

- Payload opens the database connection on startup, so the command needs a database.
  In CI a throwaway Postgres with the migrations applied is enough.
- Your config is already loaded when the command runs, so anything you do in `onInit`
  (seeding, background jobs) has to be switched off through env vars. `SEED_DB=false`
  above is just what our project uses.
- On failure it exits with `1`. Payload's own CLI would exit with `0`.

You can also build it yourself with `await buildDescriptor(payload)`.

## What's in the descriptor

There's a full example in [`test/__snapshots__`](test/__snapshots__/descriptor.test.ts.snap),
generated from a config that uses every field type. Roughly:

```jsonc
{
  "descriptorVersion": 1,
  "payloadVersion": "3.87.0",
  "generatedAt": "2026-11-04T10:00:00.000Z",
  "hash": "sha256:4f1c...",
  "lastMigration": "20261008_135516_init",
  "db": {
    "adapter": "postgres",
    "version": "16.4",
    "versionNum": 160004,
    "options": { "schemaName": "public", "idType": "serial", "blocksAsJSON": false, ... }
  },
  "localization": { "locales": ["it", "en"], "defaultLocale": "it", "fallback": true },
  "collections": [
    {
      "slug": "news",
      "dbName": null,
      "timestamps": true,
      "versions": { "drafts": true },
      "upload": false,
      "auth": false,
      "fields": [
        { "name": "title", "type": "text", "localized": false, "required": true, "hasMany": false },
        { "name": "cover", "type": "upload", "relationTo": "media", "hasMany": false, ... }
      ]
    }
  ],
  "globals": [],
  "physical": {
    "tableNameMap": { "news": "news", ... },
    "tables": { "news": { "columns": { "cover": { "name": "cover_id", "type": "integer", ... } } } }
  }
}
```

Some notes on the format:

- `hash` is a sha256 of the JSON with sorted keys, leaving out `generatedAt` and `hash`
  itself. It's also the ETag.
- `descriptorVersion` only goes up on breaking changes. New keys can show up at any time,
  so readers should ignore keys they don't know.
- `lastMigration` comes from the code, not the database. During a rollout the old pod may
  still answer, so a reader should compare this value with the last row in
  `payload_migrations` and retry until they match (that's what gopcmsdb does).
- `db.version` and `db.versionNum` come from `server_version` and `server_version_num`.
  They're `null` if the database couldn't be reached. In that case the endpoint doesn't
  cache the result and tries again on the next request.
- Functions never make it into the output. Access control, `afterRead` hooks and dynamic
  defaults show up as `hasReadAccess`, `hasAfterReadHooks` and `hasDynamicDefault` flags.
- Secrets are left out on purpose: no `secret`, no connection string or pool settings, and
  none of the auth fields Payload adds (`hash`, `salt`, reset and verification tokens,
  `apiKey`, `sessions`). There's a test for this.

## Development

```bash
pnpm install
pnpm test          # snapshot, secrets and endpoint tests, no database needed
pnpm test:update   # refresh the snapshot when you change the format on purpose
pnpm build         # ESM + .d.ts in dist/
pnpm pack          # tarball, handy for trying it in a project before publishing
```

To try a local build in a project before publishing:

```bash
pnpm pack
cd ../your-payload-project
pnpm add file:../payload-schema-descriptor/payload-schema-descriptor-0.1.0.tgz
```

## Publishing

```bash
npm version patch   # or minor / major
npm publish         # runs typecheck and tests first, then builds
git push --follow-tags
```

You need to be logged in first (`npm login`).

## Things to check when upgrading Payload

- `payload.db.rawTables` and `payload.db.tableNameMap` are internals of `@payloadcms/drizzle`,
  not public API. Last checked on 3.87.
- Collection-level `hasReadAccess` recognises Payload's default access by its function name
  (`defaultAccess`), since Payload doesn't export it.

## License

[Apache 2.0](LICENSE)
