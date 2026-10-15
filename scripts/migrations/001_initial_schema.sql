CREATE TABLE IF NOT EXISTS wallets (
    id VARCHAR(64) PRIMARY KEY,
    player_id VARCHAR(64) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance NUMERIC(16, 2) NOT NULL DEFAULT 0.00,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0)
);
CREATE INDEX IF NOT EXISTS idx_wallets_player_currency ON wallets (
    player_id, currency
);
CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
    id VARCHAR(64) PRIMARY KEY,
    wallet_id VARCHAR(64) NOT NULL REFERENCES wallets (id),
    transaction_id VARCHAR(64) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount NUMERIC(16, 2) NOT NULL,
    balance_before NUMERIC(16, 2) NOT NULL,
    balance_after NUMERIC(16, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
    -- Invariante matemática contábil:
    CONSTRAINT chk_ledger_balance_math CHECK (
        (direction = 'DEBIT' AND balance_before - amount = balance_after)
        OR (direction = 'CREDIT' AND balance_before + amount = balance_after)
    )
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created ON wallet_ledger_entries (
    wallet_id,
    created_at
);
-- Função PL/pgSQL de Imutabilidade Estrita
CREATE OR REPLACE FUNCTION TRG_PROTECT_LEDGER_ENTRIES()
RETURNS TRIGGER AS $$
BEGIN
RAISE EXCEPTION 'wallet_ledger_entries are append-only: UPDATE and DELETE operations are strictly
prohibited'
USING ERRCODE = '55000';
-- ANSI SQLSTATE: Object Not Modifiable
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_block_ledger_mutation ON wallet_ledger_entries;
CREATE TRIGGER trg_block_ledger_mutation
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION TRG_PROTECT_LEDGER_ENTRIES();
