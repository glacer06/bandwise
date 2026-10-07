-- Migration 0009: runs.policy_action (ADR-010 Amendment 1).
--
-- The overall policy action before the rollout stage applies, so usage.get can count the runs a
-- set would act on in controlled (run_band high and policy_action auto) while it is in shadow.
-- Nullable: rows written before this migration stay null and are not counted. They are not
-- backfilled, because the stored decisions do not say which ones gate. runs is partitioned, and
-- ADD COLUMN on the parent reaches every partition.

ALTER TABLE "runs" ADD COLUMN "policy_action" text;
