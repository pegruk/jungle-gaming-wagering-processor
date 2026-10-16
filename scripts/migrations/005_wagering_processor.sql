CREATE TABLE wager_transactions (
    id VARCHAR(64) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    payload_hash VARCHAR(64) NOT NULL,
    wallet_id VARCHAR(64) NOT NULL REFERENCES wallets(id),
    player_id VARCHAR(64) NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(128) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0 AND amount <> 'NaN'::numeric),
    currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(128),
    reference_transaction_id VARCHAR(64) REFERENCES wager_transactions(id),
    status VARCHAR(24) NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    failure_code VARCHAR(64),
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    pending_attempts INTEGER NOT NULL DEFAULT 0 CHECK (pending_attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    correlation_id VARCHAR(128) NOT NULL,
    UNIQUE (provider_id, external_transaction_id),
    UNIQUE (id, wallet_id, currency),
    CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
    CHECK (kind <> 'BET' OR amount > 0),
    CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
    CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR processed_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_processed_reversal ON wager_transactions(reference_transaction_id, kind)
    WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX idx_pending_reference ON wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX idx_wager_wallet ON wager_transactions(wallet_id, created_at, id);

ALTER TABLE wallet_ledger_entries ADD COLUMN currency VARCHAR(3), ADD COLUMN wallet_version INTEGER;
-- Fail rather than invent a financial history for unlinked legacy ledger rows.
ALTER TABLE wallet_ledger_entries
    ALTER COLUMN currency SET NOT NULL,
    ALTER COLUMN wallet_version SET NOT NULL,
    ADD CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id, wallet_id, currency)
        REFERENCES wager_transactions(id, wallet_id, currency) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
    ADD CONSTRAINT chk_ledger_version CHECK (wallet_version >= 1);
ALTER TABLE wallets ADD CONSTRAINT chk_wallet_finite CHECK (balance <> 'NaN'::numeric);

ALTER TABLE inbox_messages ADD COLUMN consumer_name VARCHAR(64) NOT NULL DEFAULT 'wagering-processor',
    ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_pkey,
    ADD PRIMARY KEY (consumer_name, message_id);
ALTER TABLE inbox_messages ALTER COLUMN consumer_name DROP DEFAULT;

ALTER TABLE outbox_messages
    ADD COLUMN aggregate_id VARCHAR(64) NOT NULL DEFAULT 'legacy',
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE outbox_messages ALTER COLUMN aggregate_id DROP DEFAULT;
CREATE INDEX idx_outbox_due ON outbox_messages(next_attempt_at, id) WHERE published_at IS NULL;

CREATE TABLE event_receipts (
    consumer_name VARCHAR(64) NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
);

CREATE FUNCTION protect_terminal_wager() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'terminal wager is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_wager_terminal BEFORE UPDATE OR DELETE ON wager_transactions
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_wager();
