CREATE TABLE journal_postings (
    transaction_id VARCHAR(64) NOT NULL REFERENCES wager_transactions(id),
    account_id VARCHAR(80) NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount NUMERIC(16,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
    currency VARCHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(transaction_id, account_id)
);
CREATE TRIGGER trg_journal_immutable BEFORE UPDATE OR DELETE ON journal_postings
    FOR EACH ROW EXECUTE FUNCTION TRG_PROTECT_LEDGER_ENTRIES();

CREATE FUNCTION check_journal_balance() RETURNS trigger AS $$
DECLARE tx VARCHAR(64); total NUMERIC; entries INTEGER;
BEGIN
    tx := NEW.transaction_id;
    SELECT count(*), coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)
        INTO entries,total FROM journal_postings WHERE transaction_id=tx;
    IF entries <> 2 OR total <> 0 THEN
        RAISE EXCEPTION 'unbalanced journal' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM wallet_ledger_entries l
        JOIN journal_postings w ON w.transaction_id=l.transaction_id AND w.account_id='wallet:'||l.wallet_id
            AND w.direction=l.direction AND w.amount=l.amount AND w.currency=l.currency
        JOIN journal_postings h ON h.transaction_id=l.transaction_id AND h.account_id='clearing:'||l.currency
            AND h.direction<>l.direction AND h.amount=l.amount AND h.currency=l.currency
        WHERE l.transaction_id=tx
    ) THEN RAISE EXCEPTION 'journal does not match wallet ledger' USING ERRCODE='23514'; END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON journal_postings
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();

CREATE FUNCTION check_wallet_ledger_consistency() RETURNS trigger AS $$
DECLARE target VARCHAR(64); stored NUMERIC; calculated NUMERIC;
BEGIN
    IF TG_TABLE_NAME='wallets' THEN target:=NEW.id; ELSE target:=NEW.wallet_id; END IF;
    SELECT balance INTO stored FROM wallets WHERE id=target;
    SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0)
        INTO calculated FROM wallet_ledger_entries WHERE wallet_id=target;
    IF stored <> calculated THEN RAISE EXCEPTION 'wallet balance differs from ledger' USING ERRCODE='23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM (
        SELECT balance_before, balance_after,
          lag(balance_after,1,0::numeric) OVER (ORDER BY wallet_version) previous_balance
        FROM wallet_ledger_entries WHERE wallet_id=target
      ) chain WHERE balance_before<>previous_balance
    ) THEN RAISE EXCEPTION 'ledger chain is broken' USING ERRCODE='23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id=l.transaction_id
      WHERE l.wallet_id=target AND (t.status<>'PROCESSED' OR t.kind='LOSS' OR t.amount<>l.amount OR
        (SELECT count(*) FROM journal_postings j WHERE j.transaction_id=t.id)<>2)
    ) THEN RAISE EXCEPTION 'ledger requires processed transaction and balanced journal' USING ERRCODE='23514'; END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_wallet_ledger_consistent AFTER INSERT OR UPDATE ON wallets
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_consistency();
CREATE CONSTRAINT TRIGGER trg_ledger_wallet_consistent AFTER INSERT ON wallet_ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_consistency();

CREATE FUNCTION check_wager_ledger() RETURNS trigger AS $$
BEGIN
    IF NEW.status='PROCESSED' AND NEW.kind<>'LOSS' AND NEW.amount>0 AND
        NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id=NEW.id AND wallet_id=NEW.wallet_id) THEN
      RAISE EXCEPTION 'processed financial transaction requires ledger' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_wager_has_ledger AFTER INSERT OR UPDATE ON wager_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wager_ledger();
