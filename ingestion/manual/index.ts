/**
 * Manual ingestion entry: pull this week's Sharebite menu data and persist
 * to the Store. The agent can also self-ingest on cache miss, but this CLI
 * remains for warming the cache up-front or testing the pipeline in
 * isolation.
 *
 * Prereqs:
 *   1. Sign into postman.sharebite.com in any Chrome window.
 *   2. DevTools → Application → Cookies → copy the `sessionid` value.
 *   3. Set SHAREBITE_SESSION_COOKIE in .env (or export it), then: bun ingest
 */

import { ingestUpcoming } from '../lib/ingest.ts';

async function main() {
  console.log('[ingest] starting');
  const result = await ingestUpcoming();
  console.log(
    `[ingest] complete — ingested=${result.ingested_dates.length} failed=${result.failed_dates.length}`,
  );
  if (result.failed_dates.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[ingest] fatal:', err);
  process.exit(1);
});
