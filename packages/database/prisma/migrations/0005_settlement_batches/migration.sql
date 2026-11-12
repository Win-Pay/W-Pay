-- Settlement batches are created off-chain before the operator signs the
-- on-chain window transactions, so entries must be durable and auditable.
CREATE TABLE "SettlementEntry" (
    "id" TEXT NOT NULL,
    "settlementWindowId" TEXT NOT NULL,
    "merchantId" TEXT,
    "payee" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SettlementEntry_settlementWindowId_payee_key" ON "SettlementEntry"("settlementWindowId", "payee");
CREATE INDEX "SettlementEntry_merchantId_idx" ON "SettlementEntry"("merchantId");
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_settlementWindowId_fkey" FOREIGN KEY ("settlementWindowId") REFERENCES "SettlementWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A token/period pair identifies exactly one local batch, which keeps indexer
-- linking unambiguous. The contract itself allows more; the API does not.
CREATE UNIQUE INDEX "SettlementWindow_token_periodStart_periodEnd_key" ON "SettlementWindow"("token", "periodStart", "periodEnd");
