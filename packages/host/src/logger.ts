import { redactSecrets, redactSecretText } from "./security/redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write: (line: string) => void;
}

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface CreateLoggerOptions {
  level?: LogLevel;
  sinks: LogSink[];
}

/**
 * Structured logger that only ever writes to the provided sinks (stderr
 * and/or a log file in production). It never touches process.stdout, since
 * stdout is reserved for the stdio MCP transport framing.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const minLevel = options.level ?? "info";

  function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      return;
    }
    const safeFields = redactSecrets(fields ?? {}) as Record<string, unknown>;
    const record = {
      ...safeFields,
      timestamp: new Date().toISOString(),
      level,
      message: redactSecretText(message),
    };
    const line = JSON.stringify(record) + "\n";
    for (const sink of options.sinks) {
      sink.write(line);
    }
  }

  return {
    debug: (message, fields) => {
      log("debug", message, fields);
    },
    info: (message, fields) => {
      log("info", message, fields);
    },
    warn: (message, fields) => {
      log("warn", message, fields);
    },
    error: (message, fields) => {
      log("error", message, fields);
    },
  };
}

export function stderrSink(): LogSink {
  return {
    write: (line: string) => {
      process.stderr.write(line);
    },
  };
}

export function fileSink(fd: { write: (line: string) => void }): LogSink {
  return fd;
}
