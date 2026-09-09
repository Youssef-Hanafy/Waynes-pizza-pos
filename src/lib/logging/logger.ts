type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Readonly<Record<string, boolean | number | string | null | undefined>>;

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const candidate = process.env.LOG_LEVEL;
  return candidate === "debug" || candidate === "warn" || candidate === "error" ? candidate : "info";
}

function write(level: LogLevel, message: string, context: LogContext = {}) {
  if (priorities[level] < priorities[configuredLevel()]) return;

  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, context?: LogContext) => write("debug", message, context),
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, error?: unknown, context: LogContext = {}) =>
    write("error", message, {
      ...context,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Unknown error"
    })
};
