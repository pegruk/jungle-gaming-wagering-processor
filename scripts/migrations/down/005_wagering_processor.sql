DROP TRIGGER trg_wager_terminal ON wager_transactions;
DROP FUNCTION protect_terminal_wager();
DROP TABLE event_receipts;
DROP INDEX idx_outbox_due;
ALTER TABLE outbox_messages DROP COLUMN aggregate_id, DROP COLUMN attempts,
    DROP COLUMN next_attempt_at, DROP COLUMN published_at;
ALTER TABLE inbox_messages DROP CONSTRAINT inbox_messages_pkey, ADD PRIMARY KEY(provider_id, message_id),
    DROP COLUMN consumer_name, DROP COLUMN received_at;
ALTER TABLE wallets DROP CONSTRAINT chk_wallet_finite;
ALTER TABLE wallet_ledger_entries DROP CONSTRAINT fk_ledger_transaction,
    DROP CONSTRAINT uq_ledger_wallet_version, DROP CONSTRAINT chk_ledger_version,
    DROP COLUMN currency, DROP COLUMN wallet_version;
DROP TABLE wager_transactions;
