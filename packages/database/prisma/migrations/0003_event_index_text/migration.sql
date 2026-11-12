-- Paging tokens are opaque strings. Storing them verbatim removes hash
-- collisions and makes event replay idempotency exact.
ALTER TABLE "IndexedEvent" ALTER COLUMN "eventIndex" TYPE TEXT USING "eventIndex"::text;
