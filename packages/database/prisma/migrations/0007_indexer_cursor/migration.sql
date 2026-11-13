-- Soroban RPC returns at most `limit` events per call. Persisting the paging
-- cursor lets the indexer resume inside a ledger instead of skipping the
-- remainder when a ledger contains more events than one batch.
ALTER TABLE "IndexerCheckpoint" ADD COLUMN "cursor" TEXT;
