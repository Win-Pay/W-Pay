-- Link operational rows to contract-assigned identifiers and transactions so
-- the indexer can reconcile state without guessing or duplicating records.

ALTER TABLE "Payment" ADD COLUMN "contractMerchantId" BIGINT;
CREATE INDEX "Payment_contractMerchantId_idx" ON "Payment"("contractMerchantId");

ALTER TABLE "Invoice" ADD COLUMN "contractInvoiceId" BIGINT;
ALTER TABLE "Invoice" ADD COLUMN "contractPaymentId" BIGINT;
ALTER TABLE "Invoice" ADD COLUMN "txHash" TEXT;
CREATE UNIQUE INDEX "Invoice_contractInvoiceId_key" ON "Invoice"("contractInvoiceId");
CREATE INDEX "Invoice_contractPaymentId_idx" ON "Invoice"("contractPaymentId");

ALTER TABLE "Refund" ADD COLUMN "contractRefundId" BIGINT;
CREATE UNIQUE INDEX "Refund_contractRefundId_key" ON "Refund"("contractRefundId");
CREATE INDEX "Refund_txHash_idx" ON "Refund"("txHash");

CREATE INDEX "Escrow_txHash_idx" ON "Escrow"("txHash");

ALTER TABLE "Subscription" ADD COLUMN "txHash" TEXT;
