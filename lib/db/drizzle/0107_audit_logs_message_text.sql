-- The console chat copied each message's text into audit_logs.details.message,
-- and clearing the chat history never reached those copies (audit, 2026-11-18).
-- The code no longer writes the text; this removes the copies already kept.
-- The audit rows stay: their type, ids and cost are the audit.
UPDATE audit_logs SET details = details - 'message' WHERE details ? 'message';
