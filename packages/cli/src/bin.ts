#!/usr/bin/env node
import { runDoctor, formatDoctorText, formatDoctorJson, type DoctorOptions } from "./doctor.js";
import { buildFoundryModule } from "./build-module.js";
import { parseCommandLine } from "./command-line.js";
import { runHostCommand } from "./host-command.js";
import { formatCapabilityCommandText, runCapabilityCommand } from "./capability-command.js";
import { formatProviderCommandText, runProviderCommand } from "./provider-command.js";

async function main(): Promise<void> {
  const parsed = parseCommandLine(process.argv.slice(2));

  if (parsed.command === "doctor") {
    const options = parsed.options;
    const doctorOptions: DoctorOptions = {};
    if (options.appDataDir) doctorOptions.appDataDir = options.appDataDir;
    if (options.configPath) doctorOptions.configPath = options.configPath;
    if (options.foundryUserDataPath) {
      doctorOptions.foundryUserDataPath = options.foundryUserDataPath;
    }
    if (options.dockerUserDataPath) doctorOptions.dockerUserDataPath = options.dockerUserDataPath;
    if (options.bridgeUrl) doctorOptions.bridgeUrl = options.bridgeUrl;
    if (options.foundryOrigin) doctorOptions.foundryOrigin = options.foundryOrigin;
    if (options.moduleId) doctorOptions.moduleId = options.moduleId;
    if (options.allowedOrigins.length > 0) doctorOptions.allowedOrigins = options.allowedOrigins;
    const results = await runDoctor(doctorOptions);
    process.stdout.write(
      (options.json ? formatDoctorJson(results) : formatDoctorText(results)) + "\n",
    );
    const hasFail = results.some((r) => r.status === "FAIL");
    process.exitCode = hasFail ? 1 : 0;
    return;
  }

  if (parsed.command === "build-module") {
    const options = parsed.options;
    const result = buildFoundryModule({
      ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      ...(options.version ? { version: options.version } : {}),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Built Foundry v14 module ${result.version}\nDirectory: ${result.moduleDir}\nZIP: ${result.zipPath}\n`,
    );
    return;
  }

  if (parsed.command === "capabilities") {
    const result = runCapabilityCommand(parsed.options);
    process.stdout.write(
      parsed.options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatCapabilityCommandText(result)}\n`,
    );
    return;
  }

  if (parsed.command === "provider") {
    const result = await runProviderCommand(parsed.options);
    process.stdout.write(
      parsed.options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatProviderCommandText(result)}\n`,
    );
    return;
  }

  await runHostCommand(parsed.options);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `foundry-mcp cli failed: ${message}\nusage:\n  foundry-mcp host [--config PATH] [--app-data PATH] [--port PORT] [--pipe-name NAME] [--log-level LEVEL] [--allow-origin ORIGIN]...\n  foundry-mcp capabilities list --connection-id ID [--json] [--config PATH] [--app-data PATH]\n  foundry-mcp capabilities <grant|revoke> --connection-id ID --role ROLE --capability CAPABILITY [--json] [--config PATH] [--app-data PATH]\n  foundry-mcp provider <configure|remove|status> [--json] [--app-data PATH]\n  foundry-mcp doctor [--json] [--config PATH] [--app-data PATH] [--foundry-data PATH | --docker-data PATH] [--bridge-url URL] [--foundry-origin ORIGIN] [--allow-origin ORIGIN]...\n  foundry-mcp build-module [--json] [--output DIR] [--version SEMVER]\n`,
  );
  process.exitCode = 1;
});
