-- Automatic settlement: payments are claimed by a durable batch, and each
-- batch records attempts, errors and retry timing so a worker can resume after
-- a crash without double-paying or silently dropping a batch.
ALTER TABLE "Payment"
  ADD COLUMN "settlementAmount" BIGINT,
  ADD COLUMN "settlementWindowId" TEXT;

ALTER TABLE "SettlementEntry"
  ADD COLUMN "paymentCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SettlementWindow"
  ADD COLUMN "alertedAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "batchKey" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Payment_merchantId_settlementWindowId_idx"
  ON "Payment"("merchantId", "settlementWindowId");
CREATE INDEX "Payment_status_settlementWindowId_idx"
  ON "Payment"("status", "settlementWindowId");
CREATE UNIQUE INDEX "SettlementWindow_batchKey_key"
  ON "SettlementWindow"("batchKey");
CREATE INDEX "SettlementWindow_auto_status_nextAttemptAt_idx"
  ON "SettlementWindow"("auto", "status", "nextAttemptAt");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_settlementWindowId_fkey"
  FOREIGN KEY ("settlementWindowId") REFERENCES "SettlementWindow"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
