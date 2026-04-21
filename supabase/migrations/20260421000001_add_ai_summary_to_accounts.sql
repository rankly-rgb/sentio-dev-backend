-- Add AI-generated summary cache to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_summary TEXT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ NULL;
