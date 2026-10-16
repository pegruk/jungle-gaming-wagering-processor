ALTER TABLE wallet_ledger_entries
    DROP CONSTRAINT chk_ledger_balances_non_negative,
    DROP CONSTRAINT uq_ledger_wallet_transaction;
ALTER TABLE wallets
    DROP CONSTRAINT chk_wallet_version_positive,
    DROP CONSTRAINT uq_wallet_player_currency;
