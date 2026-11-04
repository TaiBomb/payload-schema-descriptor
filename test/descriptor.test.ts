import { beforeAll, describe, expect, it } from "vitest";
import type { Payload, SanitizedConfig } from "payload";
import { buildDescriptor, CLI_COMMAND, hashDescriptor, type Descriptor } from "../src/index.js";
import { API_KEY, CONNECTION_STRING, fixtureConfig, SECRET } from "./fixture.config.js";
import { callEndpoint, findEndpoint, offlinePayload } from "./helpers.js";

let config: SanitizedConfig;
let payload: Payload;
let d: Descriptor;

const field = (fields: any[], name: string) => {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} not found`);
  return f;
};

beforeAll(async () => {
  config = await fixtureConfig();
  payload = await offlinePayload(config);
  d = await buildDescriptor(payload);
});

describe("descriptor", () => {
  it("matches the snapshot (minus generatedAt)", () => {
    const { generatedAt, ...rest } = d;
    expect(typeof generatedAt).toBe("string");
    expect(rest).toMatchSnapshot();
  });

  it("header and db info", () => {
    expect(d.descriptorVersion).toBe(1);
    expect(d.payloadVersion).toMatch(/^3\./);
    expect(d.lastMigration).toBe("20261104_120000_add_posts");
    expect(d.db).toEqual({
      adapter: "postgres",
      version: "16.4",
      versionNum: 160004,
      options: {
        schemaName: "public",
        idType: "serial",
        blocksAsJSON: false,
        localesSuffix: "_locales",
        relationshipsSuffix: "_rels",
        versionsSuffix: "_v",
      },
    });
    expect(d.localization).toEqual({
      locales: ["it", "en"],
      defaultLocale: "it",
      fallback: true,
      fallbackLocales: { en: "it" },
    });
  });

  it("hash is stable and ignores generatedAt", async () => {
    const again = await buildDescriptor(payload);
    expect(again.hash).toBe(d.hash);
    expect(hashDescriptor(d)).toBe(d.hash);
    expect(hashDescriptor({ ...d, generatedAt: "2000-01-01T00:00:00.000Z" })).toBe(d.hash);
    expect(d.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not leak secrets", () => {
    const json = JSON.stringify(d);
    for (const s of [SECRET, CONNECTION_STRING, "leakpassword", "leakuser", API_KEY]) {
      expect(json).not.toContain(s);
    }
    expect(json).not.toMatch(/connectionString|"pool"|"secret"/);
  });

  it("drops auth system fields", () => {
    const users = d.collections.find((c) => c.slug === "users")!;
    expect(users.auth).toBe(true);
    const names = users.fields.map((f) => f.name);
    for (const n of ["hash", "salt", "password", "resetPasswordToken", "_verificationToken", "apiKey", "apiKeyIndex", "sessions"]) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain("email");
  });

  it("exclude removes the collection and its tables", () => {
    expect(d.collections.map((c) => c.slug)).not.toContain("hidden-stuff");
    const tables = Object.keys((d.physical as any).tables);
    expect(tables.some((t) => t.startsWith("hidden_stuff"))).toBe(false);
    expect(Object.values((d.physical as any).tableNameMap)).not.toContain("hidden_stuff");
    expect(tables).toContain("posts");
  });

  it("collection level: versions, upload, flags", () => {
    const posts = d.collections.find((c) => c.slug === "posts")!;
    expect(posts.versions).toEqual({ drafts: true });
    expect(posts.hasReadAccess).toBe(true);
    expect(posts.hasAfterReadHooks).toBe(true);
    const media = d.collections.find((c) => c.slug === "media")!;
    expect(media.upload).toEqual({ imageSizes: ["thumbnail", "card"] });
    // Payload's default access shouldn't count
    expect(media.hasReadAccess).toBe(false);
    expect(d.collections.find((c) => c.slug === "categories")!.dbName).toBe("cats");
  });

  it("field serialization rules", () => {
    const f = d.collections.find((c) => c.slug === "posts")!.fields;
    expect(field(f, "title")).toMatchObject({ type: "text", localized: true, required: true, hasMany: false });
    expect(field(f, "tags").hasMany).toBe(true);
    expect(field(f, "layoutKind").options).toEqual(["one", "two"]);
    expect(field(f, "featured").defaultValue).toBe(false);
    expect(field(f, "publishedAt")).toMatchObject({ hasDynamicDefault: true });
    expect(field(f, "publishedAt").defaultValue).toBeUndefined();
    expect(field(f, "category")).toMatchObject({ relationTo: "categories", hasMany: false, maxDepth: 1 });
    expect(field(f, "mixed").relationTo).toEqual(["posts", "categories"]);
    expect(field(f, "cover")).toMatchObject({ type: "upload", relationTo: "media" });
    expect(field(f, "flags")).toMatchObject({ dbName: "post_flags", hasMany: true });
    expect(field(f, "internalNote").hidden).toBe(true);
    expect(field(f, "computed")).toMatchObject({ virtual: true, hasAfterReadHooks: true });
    expect(field(f, "restricted").hasReadAccess).toBe(true);
    // rows, collapsibles and unnamed tabs are flattened
    for (const n of ["rowA", "inCollapsible", "inUnnamedTab"]) expect(field(f, n).type).toBe("text");
    expect(field(f, "seo")).toMatchObject({ type: "tab", fields: [expect.objectContaining({ name: "metaTitle", localized: true })] });
    expect(field(field(f, "details").fields, "nested").fields[0].name).toBe("deep");
    expect(field(field(f, "sections").fields, "items").type).toBe("array");
    expect(field(f, "layout").blocks[0]).toMatchObject({ slug: "hero" });
    // blockReferences are resolved to the full block
    expect(field(f, "refLayout").blocks).toEqual([
      expect.objectContaining({ slug: "quote", dbName: "blk_quote", fields: expect.arrayContaining([expect.objectContaining({ name: "text" })]) }),
    ]);
    const cat = d.collections.find((c) => c.slug === "categories")!.fields;
    expect(field(cat, "posts")).toMatchObject({ type: "join", collection: "posts", on: "category" });
    // no admin config or functions in the output
    expect(JSON.stringify(f)).not.toMatch(/"(admin|labels?|hooks|access|validate|filterOptions)":/);
  });

  it("postgres physical map", () => {
    const p = d.physical as any;
    expect(p.tableNameMap.categories).toBe("cats");
    expect(p.tables.posts.columns.cover).toMatchObject({ name: "cover_id", type: "integer", reference: { table: "media", column: "id" } });
    // dbName on hasMany selects, arrays and blocks renames the child tables
    expect(p.tables.post_flags).toBeDefined();
    expect(p.tables.post_sections).toBeDefined();
    expect(Object.keys(p.tables).some((t) => t.includes("blk_quote"))).toBe(true);
    expect(p.tables.posts_locales).toBeDefined();
    expect(p.tables.posts_rels).toBeDefined();
    expect(p.tables._posts_v).toBeDefined();
  });

  it("database down: null version, no error", async () => {
    const down = await buildDescriptor(await offlinePayload(config, "down"));
    expect(down.db.version).toBeNull();
    expect(down.db.versionNum).toBeNull();
  });
});

describe("endpoint", () => {
  it("401 without a key or with the wrong one", async () => {
    expect((await callEndpoint(config, payload, {})).status).toBe(401);
    expect((await callEndpoint(config, payload, { "x-internal-api-key": "nope" })).status).toBe(401);
    const res = await callEndpoint(config, payload, { "x-internal-api-key": `${API_KEY}x` });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("200 with ETag, then 304 on If-None-Match", async () => {
    const ok = await callEndpoint(config, payload, { "x-internal-api-key": API_KEY });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.hash).toBe(d.hash);
    expect(ok.headers.get("etag")).toBe(`"${d.hash}"`);
    expect(ok.headers.get("cache-control")).toBe("no-cache");

    for (const inm of [`"${d.hash}"`, `W/"${d.hash}"`, `"other", "${d.hash}"`]) {
      const nm = await callEndpoint(config, payload, { "x-internal-api-key": API_KEY, "if-none-match": inm });
      expect(nm.status).toBe(304);
      expect(await nm.text()).toBe("");
    }
    const stale = await callEndpoint(config, payload, { "x-internal-api-key": API_KEY, "if-none-match": '"sha256:old"' });
    expect(stale.status).toBe(200);
  });

  it("custom path", async () => {
    const c = await fixtureConfig({ path: "/_db-schema" });
    expect(findEndpoint(c, "/_schema")).toBeUndefined();
    expect(findEndpoint(c, "/_db-schema")).toBeDefined();
  });

  it("enabled: false skips the endpoint but keeps the CLI command", async () => {
    const c = await fixtureConfig({ enabled: false, apiKey: undefined });
    expect(findEndpoint(c)).toBeUndefined();
    expect(c.bin?.some((b) => b.key === CLI_COMMAND)).toBe(true);
    const desc = await buildDescriptor(await offlinePayload(c));
    expect(desc.lastMigration).toBe("20261104_120000_add_posts");
    expect(desc.hash).toBe(d.hash);
  });

  it("requires apiKey when enabled", async () => {
    await expect(fixtureConfig({ apiKey: "" })).rejects.toThrow(/apiKey/);
  });
});
