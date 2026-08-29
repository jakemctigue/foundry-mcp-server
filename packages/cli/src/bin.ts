#!/usr/bin/env node
import { runDoctor, formatDoctorText, formatDoctorJson, type DoctorOptions } from "./doctor.js";

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function optionValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      values.push(value);
    }
  }
  return values;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");

  if (command === "doctor") {
    const doctorOptions: DoctorOptions = {};
    const appDataDir = optionValue(rest, "--app-data");
    const configPath = optionValue(rest, "--config");
    const foundryUserDataPath = optionValue(rest, "--foundry-data");
    const dockerUserDataPath = optionValue(rest, "--docker-data");
    const bridgeUrl = optionValue(rest, "--bridge-url");
    const foundryOrigin = optionValue(rest, "--foundry-origin");
    const moduleId = optionValue(rest, "--module-id");
    const allowedOrigins = optionValues(rest, "--allow-origin");
    if (appDataDir) doctorOptions.appDataDir = appDataDir;
    if (configPath) doctorOptions.configPath = configPath;
    if (foundryUserDataPath) doctorOptions.foundryUserDataPath = foundryUserDataPath;
    if (dockerUserDataPath) doctorOptions.dockerUserDataPath = dockerUserDataPath;
    if (bridgeUrl) doctorOptions.bridgeUrl = bridgeUrl;
    if (foundryOrigin) doctorOptions.foundryOrigin = foundryOrigin;
    if (moduleId) doctorOptions.moduleId = moduleId;
    if (allowedOrigins.length > 0) doctorOptions.allowedOrigins = allowedOrigins;
    const results = await runDoctor(doctorOptions);
    process.stdout.write((json ? formatDoctorJson(results) : formatDoctorText(results)) + "\n");
    const hasFail = results.some((r) => r.status === "FAIL");
    process.exitCode = hasFail ? 1 : 0;
    return;
  }

  process.stderr.write(
    `unknown command: ${command ?? "(none)"}\nusage: foundry-mcp doctor [--json] [--config PATH] [--app-data PATH] [--foundry-data PATH | --docker-data PATH] [--bridge-url URL] [--foundry-origin ORIGIN] [--allow-origin ORIGIN]\n`,
  );
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`foundry-mcp cli failed: ${String(err)}\n`);
  process.exitCode = 1;
});
