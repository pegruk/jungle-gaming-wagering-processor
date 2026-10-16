CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION TRG_PROTECT_LEDGER_ENTRIES();
CREATE TRIGGER trg_journal_no_truncate BEFORE TRUNCATE ON journal_postings
    FOR EACH STATEMENT EXECUTE FUNCTION TRG_PROTECT_LEDGER_ENTRIES();

CREATE OR REPLACE FUNCTION protect_terminal_wager() RETURNS trigger AS $$
BEGIN
    IF TG_OP='DELETE' OR OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'terminal wager is immutable' USING ERRCODE = '55000';
    END IF;
    IF (NEW.id,NEW.provider_id,NEW.external_transaction_id,NEW.idempotency_key,NEW.payload_hash,
        NEW.wallet_id,NEW.player_id,NEW.round_id,NEW.game_id,NEW.kind,NEW.amount,NEW.currency,
        NEW.reference_external_transaction_id,NEW.created_at,NEW.correlation_id)
       IS DISTINCT FROM
       (OLD.id,OLD.provider_id,OLD.external_transaction_id,OLD.idempotency_key,OLD.payload_hash,
        OLD.wallet_id,OLD.player_id,OLD.round_id,OLD.game_id,OLD.kind,OLD.amount,OLD.currency,
        OLD.reference_external_transaction_id,OLD.created_at,OLD.correlation_id) THEN
        RAISE EXCEPTION 'wager input is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
