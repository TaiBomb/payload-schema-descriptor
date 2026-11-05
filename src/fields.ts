import type { FlattenedField } from "payload";
import type { BlockDescriptor, FieldDescriptor, JSONValue } from "./types.js";

// Fields Payload adds to auth collections. They're either secrets or session
// state, so they never go out. They only exist at the top level.
const AUTH_SYSTEM_FIELDS = new Set([
  "hash",
  "salt",
  "password",
  "resetPasswordToken",
  "resetPasswordExpiration",
  "_verificationToken",
  "apiKey",
  "apiKeyIndex",
  "enableAPIKey",
  "sessions",
]);

const HAS_MANY_TYPES = new Set(["relationship", "upload", "select", "text", "number"]);

type AnyField = Record<string, any>;
type BlockLike = { slug: string; dbName?: unknown; flattenedFields?: FlattenedField[]; fields?: unknown[] };

export type FieldContext = {
  /** config.blocks by slug, for resolving blockReferences. */
  blocksBySlug: Map<string, BlockLike>;
};

/** Returns undefined for anything that isn't plain JSON (functions, class instances, ...). */
export function asStaticJSON(value: unknown): JSONValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "object": {
      if (Array.isArray(value)) {
        const out: JSONValue[] = [];
        for (const v of value) {
          const j = asStaticJSON(v);
          if (j === undefined) return undefined;
          out.push(j);
        }
        return out;
      }
      if (value instanceof Date) return value.toISOString();
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const out: Record<string, JSONValue> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const j = asStaticJSON(v);
        if (j === undefined) return undefined;
        out[k] = j;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** Sets out[key] when value is set and plain JSON, leaves it out otherwise. */
export function setStatic(out: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const json = asStaticJSON(value);
  if (json !== undefined) out[key] = json;
}

function serializeBlock(block: BlockLike, ctx: FieldContext): BlockDescriptor {
  const out: BlockDescriptor = { slug: block.slug, fields: [] };
  if (typeof block.dbName === "string") out.dbName = block.dbName;
  out.fields = serializeFields((block.flattenedFields ?? []) as FlattenedField[], ctx, false);
  return out;
}

function serializeBlocks(field: AnyField, ctx: FieldContext): BlockDescriptor[] {
  // With blockReferences Payload leaves `blocks` empty. Each reference is either
  // an inline block or the slug of a block defined in config.blocks.
  const source: Array<BlockLike | string> = field.blockReferences ?? field.blocks ?? [];
  return source.map((b) => {
    if (typeof b === "string") {
      const resolved = ctx.blocksBySlug.get(b);
      if (!resolved) throw new Error(`payload-schema-descriptor: block "${b}" is referenced but not defined in config.blocks`);
      return serializeBlock(resolved, ctx);
    }
    return serializeBlock(b, ctx);
  });
}

export function serializeField(field: AnyField, ctx: FieldContext): FieldDescriptor {
  const out: FieldDescriptor = { name: field.name, type: field.type };

  if (typeof field.dbName === "string") out.dbName = field.dbName;
  out.localized = Boolean(field.localized);
  out.required = Boolean(field.required);

  if (HAS_MANY_TYPES.has(field.type)) out.hasMany = Boolean(field.hasMany);

  if ((field.type === "relationship" || field.type === "upload") && field.relationTo !== undefined) {
    out.relationTo = Array.isArray(field.relationTo) ? [...field.relationTo] : field.relationTo;
  }
  if ((field.type === "relationship" || field.type === "upload" || field.type === "join") && typeof field.maxDepth === "number") {
    out.maxDepth = field.maxDepth;
  }

  if ((field.type === "select" || field.type === "radio") && Array.isArray(field.options)) {
    out.options = field.options.map((o: unknown) =>
      typeof o === "string" ? o : String((o as { value: unknown }).value),
    );
  }

  if (field.type === "join") {
    out.collection = Array.isArray(field.collection) ? [...field.collection] : field.collection;
    out.on = field.on;
    if (typeof field.defaultLimit === "number") out.defaultLimit = field.defaultLimit;
    // defaultSort and where only go out when they're plain JSON, otherwise a
    // reader would apply a different filter than Payload does
    setStatic(out, "defaultSort", field.defaultSort);
    setStatic(out, "where", field.where);
  }

  if (field.type === "group" || field.type === "tab" || field.type === "array") {
    out.fields = serializeFields(field.flattenedFields ?? [], ctx, false);
  }

  if (field.type === "blocks") {
    out.blocks = serializeBlocks(field, ctx);
  }

  // virtual can also be a string (a path through a relationship), keep it as is
  if (field.virtual) out.virtual = typeof field.virtual === "string" ? field.virtual : true;
  if (field.hidden === true) out.hidden = true;

  if (field.defaultValue !== undefined) {
    const value = asStaticJSON(field.defaultValue);
    if (value === undefined) out.hasDynamicDefault = true;
    else out.defaultValue = value;
  }

  if (typeof field.access?.read === "function") out.hasReadAccess = true;
  if (Array.isArray(field.hooks?.afterRead) && field.hooks.afterRead.length > 0) out.hasAfterReadHooks = true;

  return out;
}

export function serializeFields(fields: FlattenedField[], ctx: FieldContext, isAuthRoot: boolean): FieldDescriptor[] {
  const out: FieldDescriptor[] = [];
  for (const f of fields as AnyField[]) {
    if (!f.name) continue; // shouldn't happen with flattenedFields, but just in case
    if (isAuthRoot && AUTH_SYSTEM_FIELDS.has(f.name)) continue;
    out.push(serializeField(f, ctx));
  }
  return out;
}
