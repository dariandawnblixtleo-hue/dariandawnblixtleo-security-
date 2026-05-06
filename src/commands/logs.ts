/**
 * Command handler for `awf logs` subcommand
 */

import { OutputFormat } from '../types';
import { logger } from '../logger';
import {
  listLogSources,
  LogFormatter,
  streamLogs,
} from '../logs';
import { discoverAndSelectSource } from './logs-command-helpers';

/**
 * Options for the logs command
 */
interface LogsCommandOptions {
  /** Follow log output in real-time */
  follow?: boolean;
  /** Output format: raw, pretty, json */
  format: OutputFormat;
  /** Specific path to log directory or "running" for live container */
  source?: string;
  /** List available log sources without streaming */
  list?: boolean;
  /** Enrich logs with PID/process info (real-time only) */
  withPid?: boolean;
}

/**
 * Main handler for the `awf logs` subcommand
 *
 * @param options - Command options
 */
export async function logsCommand(options: LogsCommandOptions): Promise<void> {
  // Handle --list flag
  if (options.list) {
    const listing = await listLogSources();
    console.log(listing);
    return;
  }

  // Resolve the log source (auto-discovers if not specified)
  const source = await discoverAndSelectSource(options.source);

  // Setup formatter
  const formatter = new LogFormatter({
    format: options.format,
    colorize: process.stdout.isTTY,
  });

  // Determine if we should parse logs
  const parse = options.format !== 'raw';

  // Stream logs
  try {
    await streamLogs({
      follow: options.follow || false,
      source,
      formatter,
      parse,
      withPid: options.withPid || false,
    });
  } catch (error) {
    logger.error(`Failed to stream logs: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
