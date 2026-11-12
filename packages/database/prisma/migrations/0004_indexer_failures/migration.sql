-- Durable record of events the indexer could not apply. Projection failures
-- are retried on every tick; malformed events are visible to operators.
CREATE TABLE "IndexerFailure" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "eventIndex" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "projection" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IndexerFailure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IndexerFailure_contractId_eventIndex_key" ON "IndexerFailure"("contractId", "eventIndex");
CREATE INDEX "IndexerFailure_resolvedAt_createdAt_idx" ON "IndexerFailure"("resolvedAt", "createdAt");
CREATE INDEX "IndexerFailure_txHash_idx" ON "IndexerFailure"("txHash");
