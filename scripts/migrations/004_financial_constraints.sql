ALTER TABLE wallets
    ADD CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency),
    ADD CONSTRAINT chk_wallet_version_positive CHECK (version >= 1);

ALTER TABLE wallet_ledger_entries
    ADD CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
    ADD CONSTRAINT chk_ledger_balances_non_negative
        CHECK (balance_before >= 0 AND balance_after >= 0);
