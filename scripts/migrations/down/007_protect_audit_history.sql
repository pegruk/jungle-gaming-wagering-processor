DROP TRIGGER trg_ledger_no_truncate ON wallet_ledger_entries;
DROP TRIGGER trg_journal_no_truncate ON journal_postings;
CREATE OR REPLACE FUNCTION protect_terminal_wager() RETURNS trigger AS $$
BEGIN
    IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'terminal wager is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
