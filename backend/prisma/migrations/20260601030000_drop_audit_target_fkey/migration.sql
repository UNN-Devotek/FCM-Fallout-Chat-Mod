-- audit_logs.target_id is polymorphic (users, parties, messages, …). A FK to
-- users(id) broke party/message audit logs (P2003). Drop it. Idempotent.
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_target_id_fkey";
