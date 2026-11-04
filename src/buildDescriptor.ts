import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import type {Payload} from "payload";
import {type FieldContext, serializeFields} from "./fields.js";
import {buildDbOptions, buildPhysical, dbServerVersion} from "./physical.js";
import {type Descriptor, DESCRIPTOR_VERSION, type EntityDescriptor, type JSONValue, type StoredOptions,} from "./types.js";

export const CUSTOM_KEY = "schemaDescriptor";

/** JSON.stringify with sorted keys, so the hash doesn't depend on insertion order. */
export function canonicalJSON(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
    const keys = Object.keys(value as object)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function hashDescriptor(d: Omit<Descriptor, "hash" | "generatedAt"> & Partial<Descriptor>): string {
    const {hash: _h, generatedAt: _g, ...rest} = d;
    return `sha256:${createHash("sha256").update(canonicalJSON(rest)).digest("hex")}`;
}

let cachedPayloadVersion: string | null | undefined;

// payload doesn't export its package.json, and require.resolve("payload") makes
// Next complain ("Package payload can't be external"). So walk up from cwd
// looking for node_modules/payload instead, which also covers hoisted monorepos.
function payloadVersion(): string | null {
    if (cachedPayloadVersion !== undefined) return cachedPayloadVersion;
    let dir = process.cwd();
    for (; ;) {
        const file = path.join(dir, "node_modules", "payload", "package.json");
        try {
            if (existsSync(file)) {
                const pkg = JSON.parse(readFileSync(file, "utf8"));
                if (pkg?.name === "payload" && typeof pkg.version === "string") return (cachedPayloadVersion = pkg.version);
            }
        } catch {
            // unreadable, try the parent dir
        }
        const parent = path.dirname(dir);
        if (parent === dir) return (cachedPayloadVersion = null);
        dir = parent;
    }
}

// Payload sets defaultAccess on collections that don't define read access.
// That one shouldn't count. Matching on the name is a bit hacky, but Payload
// doesn't export the function so there's nothing to compare against.
function hasCustomReadAccess(access: any): boolean {
    const read = access?.read;
    return typeof read === "function" && read.name !== "defaultAccess";
}

function hasHooks(hooks: any, name: string): boolean {
    return Array.isArray(hooks?.[name]) && hooks[name].length > 0;
}

function versionsOf(v: any): JSONValue {
    if (!v) return false;
    return {drafts: Boolean(v.drafts)};
}

function uploadOf(u: any): JSONValue {
    if (!u) return false;
    const sizes = Array.isArray(u.imageSizes) ? u.imageSizes.map((s: { name: string }) => s.name) : [];
    return {imageSizes: sizes};
}

export type BuildDescriptorOverrides = Partial<StoredOptions>;

/**
 * Builds the descriptor from the sanitized config Payload already has in memory.
 * The endpoint and the CLI command both go through here, so their output only
 * differs in generatedAt. Plugin options are read back from config.custom.
 */
export async function buildDescriptor(payload: Payload, overrides: BuildDescriptorOverrides = {}): Promise<Descriptor> {
    const config = payload.config;
    const stored: Partial<StoredOptions> = (config.custom as any)?.[CUSTOM_KEY] ?? {};
    const exclude = new Set(overrides.exclude ?? stored.exclude ?? []);
    const lastMigration = overrides.lastMigration !== undefined ? overrides.lastMigration : (stored.lastMigration ?? null);

    const ctx: FieldContext = {
        blocksBySlug: new Map((config.blocks ?? []).map((b: any) => [b.slug, b])),
    };

    const collections: EntityDescriptor[] = config.collections
        .filter((c) => !exclude.has(c.slug))
        .map((c: any) => ({
            slug: c.slug,
            dbName: typeof c.dbName === "string" ? c.dbName : null,
            timestamps: c.timestamps !== false,
            versions: versionsOf(c.versions),
            upload: uploadOf(c.upload),
            auth: Boolean(c.auth),
            hasReadAccess: hasCustomReadAccess(c.access),
            hasAfterReadHooks: hasHooks(c.hooks, "afterRead"),
            fields: serializeFields(c.flattenedFields, ctx, Boolean(c.auth)),
        }));

    const globals: EntityDescriptor[] = config.globals
        .filter((g) => !exclude.has(g.slug))
        .map((g: any) => ({
            slug: g.slug,
            dbName: typeof g.dbName === "string" ? g.dbName : null,
            versions: versionsOf(g.versions),
            hasReadAccess: hasCustomReadAccess(g.access),
            hasAfterReadHooks: hasHooks(g.hooks, "afterRead"),
            fields: serializeFields(g.flattenedFields, ctx, false),
        }));

    const loc = config.localization;
    const localization: Descriptor["localization"] = loc
        ? {
            locales: loc.localeCodes ?? loc.locales.map((l: any) => (typeof l === "string" ? l : l.code)),
            defaultLocale: loc.defaultLocale,
            fallback: Boolean(loc.fallback),
        }
        : null;
    if (localization && loc) {
        // per-locale fallbackLocale, only included when someone actually set one
        const perLocale = (loc.locales as any[])
            .filter((l) => typeof l === "object" && l.fallbackLocale !== undefined)
            .map((l) => [l.code, l.fallbackLocale] as [string, JSONValue]);
        if (perLocale.length > 0) localization.fallbackLocales = Object.fromEntries(perLocale);
    }

    const body: Omit<Descriptor, "hash" | "generatedAt"> = {
        descriptorVersion: DESCRIPTOR_VERSION,
        payloadVersion: payloadVersion(),
        lastMigration,
        db: {adapter: payload.db.name, ...(await dbServerVersion(payload)), options: buildDbOptions(payload)},
        localization,
        collections,
        globals,
        physical: buildPhysical(payload, exclude),
    };

    const hash = hashDescriptor(body);
    return {
        descriptorVersion: body.descriptorVersion,
        payloadVersion: body.payloadVersion,
        generatedAt: new Date().toISOString(),
        hash,
        lastMigration: body.lastMigration,
        db: body.db,
        localization: body.localization,
        collections: body.collections,
        globals: body.globals,
        physical: body.physical,
    };
}
