/**
 * `payload schema:descriptor [out.json]`
 *
 * Writes the same descriptor the endpoint serves to a file, without starting
 * an HTTP server. Meant for CI.
 *
 *   SEED_DB=false pnpm payload schema:descriptor schema.json
 *
 * Output goes to the first argument, then $SCHEMA_OUT, then ./schema.json.
 * Payload connects to the database on startup, so one has to be reachable.
 * The project config is already loaded by the time this runs, so anything in
 * onInit (seeding etc.) has to be switched off through env vars beforehand.
 */
import { writeFile } from "node:fs/promises";
import { getPayload, type SanitizedConfig } from "payload";
import { buildDescriptor } from "../buildDescriptor.js";
import { CLI_COMMAND } from "../index.js";

function outputPath(): string {
  const i = process.argv.indexOf(CLI_COMMAND);
  const arg = i >= 0 ? process.argv[i + 1] : undefined;
  if (arg && !arg.startsWith("-")) return arg;
  return process.env.SCHEMA_OUT || "schema.json";
}

export const script = async (config: SanitizedConfig): Promise<void> => {
  const out = outputPath();
  try {
    const payload = await getPayload({ config });
    const descriptor = await buildDescriptor(payload);
    await writeFile(out, `${JSON.stringify(descriptor, null, 2)}\n`);
    payload.logger.info(
      `payload-schema-descriptor: wrote ${out} (${descriptor.hash}, lastMigration=${descriptor.lastMigration}, ` +
        `${descriptor.db.adapter} ${descriptor.db.version ?? "unknown version"})`,
    );
    await payload.destroy?.();
    process.exit(0);
  } catch (err) {
    // Payload's CLI logs the error but still exits with 0, which CI would treat as success.
    console.error(err);
    process.exit(1);
  }
};
