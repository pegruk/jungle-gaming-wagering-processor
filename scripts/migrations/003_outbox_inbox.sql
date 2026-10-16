CREATE TABLE IF NOT EXISTS outbox_messages (
    id VARCHAR(64) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Índice parcial para mensagens pendentes
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_messages (
    status, created_at
) WHERE status
= 'PENDING';
CREATE TABLE IF NOT EXISTS inbox_messages (
    provider_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(128) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (provider_id, message_id)
);
