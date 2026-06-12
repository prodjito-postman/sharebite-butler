/**
 * Scheduled ingestion pipeline. Runs on the cron defined by
 * `INGEST_SCHEDULE` (set at deploy time) and warms the Store with each
 * weekday's Sharebite menus.
 *
 * The agent will also self-ingest on cache miss, so this cron is
 * "best effort" — it just keeps recommendations fast by avoiding the
 * cold-start fetch on the first user request of the day.
 *
 * Environment variables (injected automatically):
 *   SHAREBITE_SESSION_COOKIE - declared as input in astropods.yml
 *   REDIS_HOST / REDIS_PORT  - from `knowledge.cache` in astropods.yml
 */

import { ingestUpcoming } from '../lib/ingest.ts';

async function main() {
  console.log('[ingest-schedule] starting');
  const result = await ingestUpcoming();
  console.log(
    `[ingest-schedule] complete — ingested=${result.ingested_dates.length} failed=${result.failed_dates.length}`,
  );
  if (result.failed_dates.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[ingest-schedule] fatal:', err);
  process.exit(1);
});
