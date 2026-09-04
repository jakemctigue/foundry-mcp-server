#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export function parsePairingArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      !["--app-data", "--output-file"].includes(option) ||
      !value ||
      value.startsWith("--") ||
      values[option]
    ) {
      throw new Error("usage: pair.mjs --app-data ABSOLUTE_PATH --output-file NEW_ABSOLUTE_FILE");
    }
    values[option] = value;
  }
  if (!values["--app-data"] || !values["--output-file"]) {
    throw new Error("--app-data and --output-file are required; pairing codes are never printed");
  }
  return { appDataDir: values["--app-data"], outputFile: values["--output-file"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parsePairingArguments(process.argv.slice(2));
    const { writeLinuxPairingCode } = await import("../../packages/host/dist/index.js");
    await writeLinuxPairingCode(options);
    process.stderr.write(
      "Pairing code saved to the requested owner-only file. Existing pairing was preserved.\n",
    );
  } catch {
    process.stderr.write(
      "Linux pairing failed. Check required absolute paths, exclusive output file, permissions, and protected master-key configuration.\n",
    );
    process.exitCode = 1;
  }
}
