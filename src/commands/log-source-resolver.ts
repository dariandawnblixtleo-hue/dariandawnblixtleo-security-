/**
 * Shared log source discovery and selection logic used by all log sub-commands.
 */

import { logger } from '../logger';
import type { LogSource, LogStatsFormat } from '../types';
import {
  discoverLogSources,
  selectMostRecent,
  validateSource,
} from '../logs/log-discovery';

/**
 * Options for controlling whether auto-selection info messages are emitted.
 * Only applies when no explicit source is provided (auto-selection path).
 */
export interface LoggingOptions {
  /** The output format being used */
  format: LogStatsFormat;
  /** Callback to determine if info logs should be shown for the given format */
  shouldLog: (format: LogStatsFormat) => boolean;
}

/**
 * Discovers and selects a log source based on user input or auto-discovery.
 * Handles validation, error messages, and optional logging.
 *
 * When a source is explicitly provided, a debug message is always emitted and
 * `loggingOptions` has no effect. When auto-selecting the most recent source,
 * info messages describing the chosen source are emitted unless `loggingOptions`
 * suppresses them for the current output format.
 *
 * @param sourceOption - User-specified source path or "running", or undefined for auto-discovery
 * @param loggingOptions - Controls whether auto-selection info messages are emitted;
 *   when omitted, those messages are always emitted
 * @returns Selected log source
 */
export async function discoverAndSelectSource(
  sourceOption: string | undefined,
  loggingOptions?: LoggingOptions
): Promise<LogSource> {
  // Discover log sources
  const sources = await discoverLogSources();

  // Determine which source to use
  let source: LogSource;

  if (sourceOption) {
    // User specified a source
    try {
      source = await validateSource(sourceOption);
      logger.debug(`Using specified source: ${sourceOption}`);
    } catch (error) {
      logger.error(
        `Invalid log source: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  } else if (sources.length === 0) {
    logger.error('No log sources found. Run awf with a command first to generate logs.');
    process.exit(1);
  } else {
    // Select most recent source
    const selected = selectMostRecent(sources);
    if (!selected) {
      logger.error('No log sources found.');
      process.exit(1);
    }
    source = selected;

    // Log which source we're using (conditionally based on format)
    const shouldEmitInfo = !loggingOptions || loggingOptions.shouldLog(loggingOptions.format);
    if (shouldEmitInfo) {
      if (source.type === 'running') {
        logger.info(`Using live logs from running container: ${source.containerName}`);
      } else {
        logger.info(`Using preserved logs from: ${source.path}`);
        if (source.dateStr) {
          logger.info(`Log timestamp: ${source.dateStr}`);
        }
      }
    }
  }

  return source;
}
