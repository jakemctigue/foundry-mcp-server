import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repositoryRoot, "scripts", "windows");
const windowsPowerShell = path.win32.join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const requiredWindowsShells = [
  { label: "PowerShell 7", executable: "pwsh.exe" },
  { label: "Windows PowerShell 5.1", executable: windowsPowerShell },
] as const;

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface CapturedTask {
  taskName: string;
  description: string;
  action: { execute: string; arguments: string; workingDirectory: string };
  trigger: { user: string; atLogOn: boolean };
  principal: { userId: string; logonType: string; runLevel: string };
  settings: { multipleInstances: string; executionTimeLimit: string };
}

function runScriptWith(
  executable: string,
  scriptName: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ScriptResult {
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(scriptsDir, scriptName),
      ...args,
    ],
    { encoding: "utf8", env, windowsHide: true },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runPowerShellFile(
  executable: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): ScriptResult {
  const result = spawnSync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
    { encoding: "utf8", env, windowsHide: true },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Windows host/logon launchers (static safety)", () => {
  it("remain PowerShell-only at the task boundary and contain no secret-bearing arguments", () => {
    for (const name of ["start-host.ps1", "install-logon-task.ps1", "remove-logon-task.ps1"]) {
      const source = fs.readFileSync(path.join(scriptsDir, name), "utf8");
      expect(source, name).not.toMatch(/\$(?:HOME|home)\s*=/);
      expect(source, name).not.toMatch(/schtasks(?:\.exe)?/i);
      expect(source, name).not.toMatch(/pairing(?:\.secret|[_-]?secret)|provider[_-]?key/i);
      expect(source, name).toContain("-LiteralPath");
    }
    const runner = fs.readFileSync(path.join(scriptsDir, "host-process.mjs"), "utf8");
    expect(runner).not.toMatch(/console\.log\s*\(/);
    expect(runner).not.toMatch(/pairing(?:\.secret|[_-]?secret)|provider[_-]?key/i);
  });
});

describe.runIf(process.platform === "win32")(
  "Windows host/logon launchers (PS7 and PS5.1)",
  () => {
    for (const shell of requiredWindowsShells) {
      describe(shell.label, () => {
        const dirs: string[] = [];

        afterEach(() => {
          for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
        });

        function tmpDir(label: string): string {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fmcp-logon-${label}-Ω-`));
          dirs.push(dir);
          return dir;
        }

        function realScheduledTaskExists(taskName: string): boolean {
          const result = spawnSync(
            shell.executable,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$task = Get-ScheduledTask -TaskName $env:FMCP_VERIFY_TASK -ErrorAction SilentlyContinue; if ($null -eq $task) { exit 0 } else { exit 23 }",
            ],
            {
              encoding: "utf8",
              env: { ...process.env, FMCP_VERIFY_TASK: taskName },
              windowsHide: true,
            },
          );
          if (result.error) throw result.error;
          if (result.status === 0) return false;
          if (result.status === 23) return true;
          throw new Error(`Could not inspect Scheduled Task state: ${result.stderr}`);
        }

        function repositoryFixture(): { repository: string; appData: string } {
          const repository = path.join(tmpDir("repo-parent"), "Repository Ω With Spaces");
          const hostDist = path.join(repository, "packages", "host", "dist");
          const windowsScripts = path.join(repository, "scripts", "windows");
          fs.mkdirSync(hostDist, { recursive: true });
          fs.mkdirSync(windowsScripts, { recursive: true });
          fs.writeFileSync(path.join(repository, "package.json"), '{"type":"module"}\n');
          fs.writeFileSync(
            path.join(hostDist, "index.js"),
            [
              'import fs from "node:fs";',
              "export async function startDaemon(options) {",
              "  if (process.env.FMCP_HOST_CAPTURE) fs.writeFileSync(process.env.FMCP_HOST_CAPTURE, JSON.stringify(options));",
              "  setTimeout(() => process.emit('SIGTERM'), 100);",
              "  return { companionEndpoint: 'ws://127.0.0.1:32123', pipePath: String.raw`\\\\.\\pipe\\foundry-mcp-test`, shutdown: async () => { if (process.env.FMCP_HOST_SHUTDOWN) fs.writeFileSync(process.env.FMCP_HOST_SHUTDOWN, 'closed'); } };",
              "}",
            ].join("\n"),
          );
          fs.copyFileSync(
            path.join(scriptsDir, "start-host.ps1"),
            path.join(windowsScripts, "start-host.ps1"),
          );
          fs.copyFileSync(
            path.join(scriptsDir, "host-process.mjs"),
            path.join(windowsScripts, "host-process.mjs"),
          );
          return {
            repository,
            appData: path.join(tmpDir("app-data-parent"), "App Data Ω With Spaces"),
          };
        }

        it("previews an absolute loopback host launch without starting Node or creating app data", () => {
          const fixture = repositoryFixture();
          const result = runScriptWith(shell.executable, "start-host.ps1", [
            "-RepositoryPath",
            fixture.repository,
            "-NodePath",
            process.execPath,
            "-ListenHost",
            "127.0.0.1",
            "-AllowedOriginsCsv",
            "http://localhost:30000,https://foundry.example.test",
            "-CompanionPort",
            "32123",
            "-AppDataPath",
            fixture.appData,
            "-WhatIf",
          ]);

          expect(result.status, result.stderr).toBe(0);
          expect(`${result.stdout}\n${result.stderr}`).toMatch(/planned|what if/i);
          expect(result.stdout).toContain("Repository");
          expect(result.stdout).toContain("With Spaces");
          expect(result.stdout).toContain(process.execPath);
          expect(result.stdout).toContain("127.0.0.1:32123");
          expect(result.stdout).not.toMatch(/ready|started/i);
          expect(fs.existsSync(fixture.appData)).toBe(false);
        });

        it("starts the built host in the foreground with structured non-sensitive options", () => {
          const fixture = repositoryFixture();
          const capturePath = path.join(tmpDir("host-capture"), "options.json");
          const shutdownPath = path.join(tmpDir("host-shutdown"), "closed.txt");
          const result = runScriptWith(
            shell.executable,
            "start-host.ps1",
            [
              "-RepositoryPath",
              fixture.repository,
              "-NodePath",
              process.execPath,
              "-ListenHost",
              "127.0.0.1",
              "-AllowedOriginsCsv",
              "http://localhost:30000,https://foundry.example.test",
              "-CompanionPort",
              "32123",
              "-PipeName",
              "foundry-mcp-test",
              "-LogLevel",
              "warn",
              "-AppDataPath",
              fixture.appData,
            ],
            {
              ...process.env,
              FMCP_HOST_CAPTURE: capturePath,
              FMCP_HOST_SHUTDOWN: shutdownPath,
            },
          );

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).toMatch(/host ready.*127\.0\.0\.1:32123/i);
          const options = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
            appDataDir: string;
            cliConfig: {
              port: number;
              pipeName: string;
              logLevel: string;
              allowedOrigins: string[];
            };
          };
          expect(options).toEqual({
            appDataDir: fixture.appData,
            cliConfig: {
              port: 32123,
              pipeName: "foundry-mcp-test",
              logLevel: "warn",
              allowedOrigins: ["http://localhost:30000", "https://foundry.example.test"],
            },
          });
          expect(fs.readFileSync(shutdownPath, "utf8")).toBe("closed");
          expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/[A-Z2-7]{40,}/);
        }, 30000);

        it("rejects relative paths, wildcard origins, and non-loopback listeners before launch", () => {
          const fixture = repositoryFixture();
          const relative = runScriptWith(shell.executable, "start-host.ps1", [
            "-RepositoryPath",
            ".",
            "-NodePath",
            process.execPath,
            "-AllowedOriginsCsv",
            "http://localhost:30000",
            "-WhatIf",
          ]);
          expect(relative.status).not.toBe(0);
          expect(relative.stderr).toMatch(/absolute local path/i);

          const wildcard = runScriptWith(shell.executable, "start-host.ps1", [
            "-RepositoryPath",
            fixture.repository,
            "-NodePath",
            process.execPath,
            "-AllowedOriginsCsv",
            "*",
            "-WhatIf",
          ]);
          expect(wildcard.status).not.toBe(0);
          expect(wildcard.stderr).toMatch(/origin|wildcard/i);

          const remote = runScriptWith(shell.executable, "start-host.ps1", [
            "-RepositoryPath",
            fixture.repository,
            "-NodePath",
            process.execPath,
            "-ListenHost",
            "0.0.0.0",
            "-AllowedOriginsCsv",
            "http://localhost:30000",
            "-WhatIf",
          ]);
          expect(remote.status).not.toBe(0);
          expect(remote.stderr).toMatch(/127\.0\.0\.1|valid set/i);
        });

        it("registers and removes only a mocked limited current-user logon task", () => {
          const fixture = repositoryFixture();
          const capturePath = path.join(tmpDir("capture"), "task.json");
          const removalPath = path.join(tmpDir("removal"), "removed.txt");
          const wrapper = path.join(tmpDir("wrapper"), "mock-task-roundtrip.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "$global:FMCPRegisteredTask = $null",
              "function global:New-ScheduledTaskAction {",
              "  [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)",
              "  [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }",
              "}",
              "function global:New-ScheduledTaskTrigger {",
              "  [CmdletBinding()] param([switch]$AtLogOn, [string]$User)",
              "  [pscustomobject]@{ AtLogOn = [bool]$AtLogOn; User = $User }",
              "}",
              "function global:New-ScheduledTaskPrincipal {",
              "  [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel)",
              "  [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }",
              "}",
              "function global:New-ScheduledTaskSettingsSet {",
              "  [CmdletBinding()] param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, [string]$MultipleInstances, [TimeSpan]$ExecutionTimeLimit)",
              "  [pscustomobject]@{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit.ToString() }",
              "}",
              "function global:Register-ScheduledTask {",
              "  [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [string]$Description, [switch]$Force)",
              "  $global:FMCPRegisteredTask = [pscustomobject]@{ TaskName = $TaskName; Description = $Description; Actions = @($Action); Principal = $Principal }",
              "  $payload = [ordered]@{ taskName = $TaskName; description = $Description; action = [ordered]@{ execute = $Action.Execute; arguments = $Action.Arguments; workingDirectory = $Action.WorkingDirectory }; trigger = [ordered]@{ user = $Trigger.User; atLogOn = $Trigger.AtLogOn }; principal = [ordered]@{ userId = $Principal.UserId; logonType = $Principal.LogonType; runLevel = $Principal.RunLevel }; settings = [ordered]@{ multipleInstances = $Settings.MultipleInstances; executionTimeLimit = $Settings.ExecutionTimeLimit } }",
              "  [IO.File]::WriteAllText($env:FMCP_CAPTURE_PATH, ($payload | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))",
              "  $global:FMCPRegisteredTask",
              "}",
              "function global:Get-ScheduledTask {",
              "  [CmdletBinding()] param([string]$TaskName)",
              "  if ($null -ne $global:FMCPRegisteredTask -and $global:FMCPRegisteredTask.TaskName -eq $TaskName) { $global:FMCPRegisteredTask }",
              "}",
              "function global:Unregister-ScheduledTask {",
              "  [CmdletBinding()] param([string]$TaskName, [switch]$Confirm)",
              "  [IO.File]::WriteAllText($env:FMCP_REMOVAL_PATH, $TaskName, (New-Object Text.UTF8Encoding($false)))",
              "  $global:FMCPRegisteredTask = $null",
              "}",
              "& $env:FMCP_INSTALL_TASK_SCRIPT -RepositoryPath $env:FMCP_REPOSITORY -NodePath $env:FMCP_NODE -AllowedOrigin @('http://localhost:30000', 'https://foundry.example.test') -CompanionPort 32123 -AppDataPath $env:FMCP_APP_DATA -TaskName $env:FMCP_TASK_NAME",
              "& $env:FMCP_REMOVE_TASK_SCRIPT -RepositoryPath $env:FMCP_REPOSITORY -TaskName $env:FMCP_TASK_NAME",
            ].join("\r\n"),
          );
          const taskName = `Foundry MCP Test ${path
            .basename(tmpDir("task-name"))
            .replace(/[^A-Za-z0-9._-]/g, "_")}`;
          expect(realScheduledTaskExists(taskName)).toBe(false);
          const result = runPowerShellFile(shell.executable, wrapper, {
            ...process.env,
            PSModulePath: tmpDir("empty-modules"),
            FMCP_CAPTURE_PATH: capturePath,
            FMCP_REMOVAL_PATH: removalPath,
            FMCP_INSTALL_TASK_SCRIPT: path.join(scriptsDir, "install-logon-task.ps1"),
            FMCP_REMOVE_TASK_SCRIPT: path.join(scriptsDir, "remove-logon-task.ps1"),
            FMCP_REPOSITORY: fixture.repository,
            FMCP_NODE: process.execPath,
            FMCP_APP_DATA: fixture.appData,
            FMCP_TASK_NAME: taskName,
          });

          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toMatch(/Installed per-user logon task/);
          expect(result.stdout).toMatch(/Removed per-user logon task/);
          const captured = JSON.parse(fs.readFileSync(capturePath, "utf8")) as CapturedTask;
          expect(captured.taskName).toBe(taskName);
          expect(captured.description).toMatch(/Foundry MCP per-user broker host launcher.*schema 1/i);
          expect(path.isAbsolute(captured.action.execute)).toBe(true);
          expect(captured.action.workingDirectory).toBe(fixture.repository);
          expect(captured.action.arguments).toContain(path.join(fixture.repository, "scripts", "windows", "start-host.ps1"));
          expect(captured.action.arguments).toContain(process.execPath);
          expect(captured.action.arguments).toContain("127.0.0.1");
          expect(captured.action.arguments).toContain("http://localhost:30000");
          expect(captured.action.arguments).toContain("https://foundry.example.test");
          expect(captured.action.arguments).not.toMatch(/pairing|secret|token|credential/i);
          expect(captured.trigger.atLogOn).toBe(true);
          expect(captured.trigger.user).toBe(captured.principal.userId);
          expect(captured.principal.logonType).toMatch(/Interactive/i);
          expect(captured.principal.runLevel).toMatch(/Limited/i);
          expect(captured.settings.multipleInstances).toMatch(/IgnoreNew/i);
          expect(captured.settings.executionTimeLimit).toBe("00:00:00");
          expect(fs.readFileSync(removalPath, "utf8")).toBe(taskName);
          expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/pairing|secret|token|credential/i);
          expect(realScheduledTaskExists(taskName)).toBe(false);
        }, 30000);

        it("makes install/remove WhatIf explicit without invoking task mutation APIs", () => {
          const fixture = repositoryFixture();
          const wrapper = path.join(tmpDir("whatif-wrapper"), "mock-task-whatif.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "function global:New-ScheduledTaskAction { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskTrigger { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskPrincipal { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskSettingsSet { throw 'TASK MUTATION API CALLED' }",
              "function global:Register-ScheduledTask { throw 'TASK MUTATION API CALLED' }",
              "function global:Get-ScheduledTask {",
              "  [pscustomobject]@{ TaskName = $env:FMCP_TASK_NAME; Description = 'Foundry MCP per-user broker host launcher (schema 1).'; Actions = @([pscustomobject]@{ Execute = $env:FMCP_POWERSHELL; Arguments = ('-File \"' + $env:FMCP_LAUNCHER + '\"') }); Principal = [pscustomobject]@{ UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name } }",
              "}",
              "function global:Unregister-ScheduledTask { throw 'TASK MUTATION API CALLED' }",
              "& $env:FMCP_INSTALL_TASK_SCRIPT -RepositoryPath $env:FMCP_REPOSITORY -NodePath $env:FMCP_NODE -AllowedOrigin 'http://localhost:30000' -TaskName $env:FMCP_TASK_NAME -WhatIf",
              "& $env:FMCP_REMOVE_TASK_SCRIPT -RepositoryPath $env:FMCP_REPOSITORY -TaskName $env:FMCP_TASK_NAME -WhatIf",
            ].join("\r\n"),
          );
          const taskName = `Foundry MCP WhatIf ${path
            .basename(tmpDir("whatif-name"))
            .replace(/[^A-Za-z0-9._-]/g, "_")}`;
          expect(realScheduledTaskExists(taskName)).toBe(false);
          const result = runPowerShellFile(shell.executable, wrapper, {
            ...process.env,
            PSModulePath: tmpDir("empty-modules"),
            FMCP_INSTALL_TASK_SCRIPT: path.join(scriptsDir, "install-logon-task.ps1"),
            FMCP_REMOVE_TASK_SCRIPT: path.join(scriptsDir, "remove-logon-task.ps1"),
            FMCP_REPOSITORY: fixture.repository,
            FMCP_NODE: process.execPath,
            FMCP_TASK_NAME: taskName,
            FMCP_POWERSHELL: shell.executable,
            FMCP_LAUNCHER: path.join(fixture.repository, "scripts", "windows", "start-host.ps1"),
          });

          expect(result.status, result.stderr).toBe(0);
          expect(`${result.stdout}\n${result.stderr}`).toMatch(/planned|what if/i);
          expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/TASK MUTATION API CALLED/);
          expect(result.stdout).not.toMatch(/Installed per-user|Removed per-user/i);
          expect(realScheduledTaskExists(taskName)).toBe(false);
        }, 30000);

        it("refuses to overwrite an unrelated existing task with the requested name", () => {
          const fixture = repositoryFixture();
          const wrapper = path.join(tmpDir("foreign-wrapper"), "mock-foreign-task.ps1");
          fs.writeFileSync(
            wrapper,
            [
              "$ErrorActionPreference = 'Stop'",
              "function global:Get-ScheduledTask {",
              "  [CmdletBinding()] param([string]$TaskName)",
              "  [pscustomobject]@{ TaskName = $TaskName; Description = 'Unrelated task'; Actions = @(); Principal = [pscustomobject]@{ UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name } }",
              "}",
              "function global:New-ScheduledTaskAction { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskTrigger { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskPrincipal { throw 'TASK MUTATION API CALLED' }",
              "function global:New-ScheduledTaskSettingsSet { throw 'TASK MUTATION API CALLED' }",
              "function global:Register-ScheduledTask { throw 'TASK MUTATION API CALLED' }",
              "& $env:FMCP_INSTALL_TASK_SCRIPT -RepositoryPath $env:FMCP_REPOSITORY -NodePath $env:FMCP_NODE -AllowedOrigin 'http://localhost:30000' -TaskName $env:FMCP_TASK_NAME",
            ].join("\r\n"),
          );
          const taskName = `Foundry MCP Foreign ${path
            .basename(tmpDir("foreign-name"))
            .replace(/[^A-Za-z0-9._-]/g, "_")}`;
          expect(realScheduledTaskExists(taskName)).toBe(false);
          const result = runPowerShellFile(shell.executable, wrapper, {
            ...process.env,
            PSModulePath: tmpDir("empty-modules"),
            FMCP_INSTALL_TASK_SCRIPT: path.join(scriptsDir, "install-logon-task.ps1"),
            FMCP_REPOSITORY: fixture.repository,
            FMCP_NODE: process.execPath,
            FMCP_TASK_NAME: taskName,
          });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toMatch(/not an owned Foundry MCP logon launcher/i);
          expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/TASK MUTATION API CALLED/);
          expect(realScheduledTaskExists(taskName)).toBe(false);
        }, 30000);
      });
    }
  },
);
