/**
 * Shared helper functions for log commands (stats, summary, audit)
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import type { LogSource, LogStatsFormat, PolicyManifest } from '../types';
import { loadAndAggregate, loadAllLogs } from '../logs/log-aggregator';
import type { AggregatedStats } from '../logs/log-aggregator';
import { enrichWithPolicyRules, computeRuleStats } from '../logs/audit-enricher';
import { formatStats } from '../logs/stats-formatter';
import { discoverAndSelectSource } from './log-source-resolver';
export { discoverAndSelectSource } from './log-source-resolver';
export type { LoggingOptions } from './log-source-resolver';

/**
 * Attempts to find a policy-manifest.json near a log source path.
 * Returns null if not found.
 */
export function findPolicyManifestForSource(source: LogSource): PolicyManifest | null {
  if (source.type === 'running' || !source.path) return null;

  const candidates = [
    path.join(source.path, 'policy-manifest.json'),
    path.join(source.path, '..', 'audit', 'policy-manifest.json'),
    source.path.replace(/squid-logs-/, 'awf-audit-').replace(/\/?$/, '/policy-manifest.json'),
  ];

  // AWF_AUDIT_DIR is a fallback, not priority — prefer manifests co-located with
  // the selected log source to avoid cross-run mismatch
  const auditDirEnv = process.env.AWF_AUDIT_DIR;
  if (auditDirEnv) {
    candidates.push(path.join(auditDirEnv, 'policy-manifest.json'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        return JSON.parse(content) as PolicyManifest;
      }
    } catch {
      // Skip
    }
  }

  return null;
}

/**
 * Loads and aggregates logs from a source, handling errors gracefully.
 * Automatically enriches with policy rule stats when a manifest is available.
 *
 * @param source - Log source to load from
 * @returns Aggregated statistics
 */
async function loadLogsWithErrorHandling(
  source: LogSource
): Promise<AggregatedStats> {
  try {
    const stats = await loadAndAggregate(source);

    // Try to enrich with policy rule stats
    const manifest = findPolicyManifestForSource(source);
    if (manifest) {
      const entries = await loadAllLogs(source);
      const enriched = enrichWithPolicyRules(entries, manifest);
      stats.byRule = computeRuleStats(enriched, manifest);
      logger.debug('Enriched stats with policy rule matching');
    }

    return stats;
  } catch (error) {
    logger.error(`Failed to load logs: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Shared output pipeline for `logs stats` and `logs summary`.
 *
 * Discovers the log source, loads and aggregates the logs, formats them, and
 * prints the result. Each command passes only the `shouldLog` predicate that
 * controls whether informational source-selection messages are emitted.
 *
 * @param options - Command options containing `format` and optional `source`
 * @param shouldLog - Returns true when info-level log messages should be shown
 */
export async function runLogsCommand(
  options: { format: LogStatsFormat; source?: string },
  shouldLog: (format: LogStatsFormat) => boolean
): Promise<void> {
  const source = await discoverAndSelectSource(options.source, {
    format: options.format,
    shouldLog,
  });

  const stats = await loadLogsWithErrorHandling(source);

  const colorize = !!(process.stdout.isTTY && options.format === 'pretty');
  const output = formatStats(stats, options.format, colorize);
  console.log(output);
}
