/**
 * Scheduled ingestion pipeline — stub.
 *
 * Intended to run on the cron defined by `INGEST_SCHEDULE` (set at deploy
 * time) and populate Redis with each weekday's Sharebite menus, same as
 * `bun ingest` does locally via ingestion/manual/index.ts.
 *
 * Not yet wired: extract the shared run() out of ingestion/manual/index.ts
 * into ingestion/lib/ and call it from here. Until then this container
 * builds and exits cleanly without doing work.
 *
 * Environment variables (injected automatically):
 *   SHAREBITE_SESSION_COOKIE - declared as input in astropods.yml
 *   REDIS_HOST / REDIS_PORT  - from `knowledge.cache` in astropods.yml
 */

async function main() {
  console.log('[ingest-schedule] stub — no work performed. See JSDoc.');
}

main().catch(console.error);
