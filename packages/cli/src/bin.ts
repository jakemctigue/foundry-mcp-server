#!/usr/bin/env node
import { runDoctor, formatDoctorText, formatDoctorJson } from "./doctor.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");

  if (command === "doctor") {
    const results = await runDoctor();
    process.stdout.write((json ? formatDoctorJson(results) : formatDoctorText(results)) + "\n");
    const hasFail = results.some((r) => r.status === "FAIL");
    process.exitCode = hasFail ? 1 : 0;
    return;
  }

  process.stderr.write(
    `unknown command: ${command ?? "(none)"}\nusage: foundry-mcp doctor [--json]\n`,
  );
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`foundry-mcp cli failed: ${String(err)}\n`);
  process.exitCode = 1;
});
