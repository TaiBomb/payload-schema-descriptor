/**
 * Test config that tries to hit every field type: groups, named tabs, nested
 * arrays, blocks (inline and via blockReferences), localized fields, single,
 * hasMany and polymorphic relationships, uploads with imageSizes, join, point,
 * virtual and hidden fields, custom dbNames, static and dynamic defaults.
 */
import { postgresAdapter } from "@payloadcms/db-postgres";
import { buildConfig, type Block, type Config } from "payload";
import { schemaDescriptorPlugin } from "../src/index.js";

export const SECRET = "test-secret-should-never-leak-9f8e7d";
export const CONNECTION_STRING = "postgres://leakuser:leakpassword@db.invalid:5432/leakdb";
export const API_KEY = "test-api-key-123";

// We don't need a real editor, a richText field is just a jsonb column here.
const fakeEditor = (async () => ({
  CellComponent: "",
  FieldComponent: "",
  validate: () => true,
})) as unknown as Config["editor"];

// Payload mutates blocks while sanitizing, so every config needs a fresh one.
const quoteBlock = (): Block => ({
  slug: "quote",
  dbName: "blk_quote",
  fields: [
    { name: "text", type: "textarea", required: true, localized: true },
    { name: "author", type: "relationship", relationTo: "users" },
  ],
});

export const fixtureConfig = (options: Partial<Parameters<typeof schemaDescriptorPlugin>[0]> = {}) =>
  buildConfig({
    secret: SECRET,
    editor: fakeEditor,
    blocks: [quoteBlock()],
    localization: {
      locales: [
        { code: "it", label: "Italiano" },
        { code: "en", label: "English", fallbackLocale: "it" },
      ],
      defaultLocale: "it",
      fallback: true,
    },
    collections: [
      {
        slug: "users",
        auth: { useAPIKey: true, verify: true },
        fields: [{ name: "displayName", type: "text" }],
      },
      {
        slug: "media",
        upload: {
          imageSizes: [
            { name: "thumbnail", width: 100, height: 100 },
            { name: "card", width: 640 },
          ],
        },
        fields: [{ name: "alt", type: "text", localized: true }],
      },
      {
        slug: "categories",
        dbName: "cats",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "posts", type: "join", collection: "posts", on: "category" },
        ],
      },
      {
        slug: "posts",
        versions: { drafts: true },
        access: { read: () => true },
        hooks: { afterRead: [({ doc }) => doc] },
        fields: [
          { name: "title", type: "text", required: true, localized: true },
          { name: "tags", type: "text", hasMany: true },
          { name: "summary", type: "textarea" },
          { name: "contactEmail", type: "email" },
          { name: "scores", type: "number", hasMany: true },
          { name: "featured", type: "checkbox", defaultValue: false },
          { name: "publishedAt", type: "date", defaultValue: () => new Date().toISOString() },
          { name: "snippet", type: "code" },
          { name: "meta", type: "json" },
          { name: "location", type: "point" },
          { name: "layoutKind", type: "radio", options: [{ label: "Uno", value: "one" }, "two"], defaultValue: "one" },
          { name: "flags", type: "select", hasMany: true, dbName: "post_flags", options: ["a", "b", "c"] },
          { name: "category", type: "relationship", relationTo: "categories", maxDepth: 1 },
          { name: "related", type: "relationship", relationTo: "posts", hasMany: true },
          { name: "mixed", type: "relationship", relationTo: ["posts", "categories"], hasMany: true },
          { name: "cover", type: "upload", relationTo: "media" },
          { name: "body", type: "richText", localized: true },
          {
            name: "internalNote",
            type: "text",
            hidden: true,
          },
          {
            name: "computed",
            type: "number",
            virtual: true,
            hooks: { afterRead: [() => 42] },
          },
          {
            name: "restricted",
            type: "text",
            access: { read: ({ req }) => Boolean(req.user) },
          },
          {
            type: "row",
            fields: [
              { name: "rowA", type: "text" },
              { type: "collapsible", label: "c", fields: [{ name: "inCollapsible", type: "text" }] },
            ],
          },
          {
            type: "tabs",
            tabs: [
              { label: "Senza nome", fields: [{ name: "inUnnamedTab", type: "text" }] },
              { name: "seo", label: "SEO", fields: [{ name: "metaTitle", type: "text", localized: true }] },
            ],
          },
          {
            name: "details",
            type: "group",
            fields: [
              { name: "subtitle", type: "text" },
              { name: "nested", type: "group", fields: [{ name: "deep", type: "number" }] },
            ],
          },
          {
            name: "sections",
            type: "array",
            dbName: "post_sections",
            localized: true,
            fields: [
              { name: "heading", type: "text" },
              { name: "items", type: "array", fields: [{ name: "label", type: "text" }] },
            ],
          },
          {
            name: "layout",
            type: "blocks",
            blocks: [
              {
                slug: "hero",
                fields: [
                  { name: "headline", type: "text" },
                  { name: "image", type: "upload", relationTo: "media" },
                ],
              },
            ],
          },
          { name: "refLayout", type: "blocks", blocks: [], blockReferences: ["quote"] },
        ],
      },
      {
        slug: "hidden-stuff",
        fields: [{ name: "x", type: "text" }],
      },
    ],
    globals: [
      {
        slug: "settings",
        fields: [
          { name: "siteName", type: "text", localized: true },
          { name: "homepage", type: "relationship", relationTo: "posts" },
        ],
      },
    ],
    db: postgresAdapter({
      pool: { connectionString: CONNECTION_STRING },
    }),
    plugins: [
      schemaDescriptorPlugin({
        apiKey: API_KEY,
        migrations: [{ name: "20260101_000000_init" }, { name: "20261104_120000_add_posts" }],
        exclude: ["hidden-stuff"],
        ...options,
      }),
    ],
  });
