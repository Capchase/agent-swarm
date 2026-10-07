import { LogLevel } from "@slack/bolt";

const SLACK_LOG_LEVELS: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

/**
 * Bolt log level, set only by SLACK_LOG_LEVEL. It does not follow NODE_ENV: DEBUG makes the
 * Slack SDK log request and response payloads, which leaked secrets into production logs.
 */
export function resolveSlackLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  return SLACK_LOG_LEVELS[(env.SLACK_LOG_LEVEL ?? "info").toLowerCase()] ?? LogLevel.INFO;
}
