-- Add retry tracking columns to webhook_dead_letter for DLQ replay worker
ALTER TABLE webhook_dead_letter
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

-- Index for efficient DLQ retry queries
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_retry
  ON webhook_dead_letter (retry_count, created_at)
  WHERE retry_count < 3;

COMMENT ON COLUMN webhook_dead_letter.retry_count IS 'Number of replay attempts (max 3)';
COMMENT ON COLUMN webhook_dead_letter.last_retry_at IS 'Timestamp of last replay attempt';
