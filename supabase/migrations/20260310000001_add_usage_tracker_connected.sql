-- Migration: add usage_tracker_connected to accounts
-- Indicates whether the organization has an active usage tracker
-- (at least 1 usage_event in last 30 days). Updated by calculate-scores cron.

ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS usage_tracker_connected BOOLEAN NOT NULL DEFAULT FALSE;
