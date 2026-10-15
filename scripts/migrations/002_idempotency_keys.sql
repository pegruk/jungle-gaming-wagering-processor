CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(128) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    -- SHA-256 canônico
    response_status INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idempotency_provider ON idempotency_keys (
    provider_id, created_at
);
