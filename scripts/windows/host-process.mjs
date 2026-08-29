import { pathToFileURL } from "node:url";

const rawLaunchConfiguration = process.env.FOUNDRY_MCP_HOST_LAUNCH;
delete process.env.FOUNDRY_MCP_HOST_LAUNCH;
if (!rawLaunchConfiguration) {
  throw new Error("host launch configuration is unavailable");
}

const launch = JSON.parse(rawLaunchConfiguration);
const hostModule = await import(pathToFileURL(launch.hostEntry).href);
if (typeof hostModule.startDaemon !== "function") {
  throw new TypeError("built host entry point does not export startDaemon");
}

let daemon;
let stopping = false;

const errorKind = (error) => (error instanceof Error ? error.name : "Error");
const shutdown = async (exitCode) => {
  if (stopping) return;
  stopping = true;
  try {
    if (daemon) await daemon.shutdown();
  } catch (error) {
    console.error(`foundry-mcp host shutdown failed (${errorKind(error)})`);
    exitCode = 1;
  }
  process.exit(exitCode);
};

try {
  daemon = await hostModule.startDaemon({
    appDataDir: launch.appDataPath || undefined,
    cliConfig: {
      port: launch.port,
      pipeName: launch.pipeName,
      logLevel: launch.logLevel,
      allowedOrigins: launch.allowedOrigins,
    },
  });
  const companionEndpoint = new URL(daemon.companionEndpoint);
  if (companionEndpoint.hostname !== launch.listenHost) {
    throw new Error("host did not bind its companion endpoint to the requested loopback address");
  }
  console.error(
    `foundry-mcp host ready; companion endpoint ${daemon.companionEndpoint}; local pipe ${daemon.pipePath}`,
  );
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGBREAK", () => void shutdown(0));
  process.once("uncaughtException", (error) => {
    console.error(`foundry-mcp host failed (${errorKind(error)})`);
    void shutdown(1);
  });
  process.once("unhandledRejection", (error) => {
    console.error(`foundry-mcp host failed (${errorKind(error)})`);
    void shutdown(1);
  });
  await new Promise(() => {});
} catch (error) {
  console.error(`foundry-mcp host failed (${errorKind(error)}); run doctor for details`);
  await shutdown(1);
}
