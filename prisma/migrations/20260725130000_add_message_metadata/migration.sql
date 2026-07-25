-- Structured extras for a message. First use: WhatsApp interactive replies
-- (list/button taps) store { interactiveReply: { type, id, title } } so the
-- chat UI can show the human-readable title in the bubble while the payload
-- id stays queryable for support/debugging.
ALTER TABLE "Message" ADD COLUMN "metadata" JSONB;
