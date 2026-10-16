DROP TRIGGER trg_wager_has_ledger ON wager_transactions;
DROP FUNCTION check_wager_ledger();
DROP TRIGGER trg_wallet_ledger_consistent ON wallets;
DROP TRIGGER trg_ledger_wallet_consistent ON wallet_ledger_entries;
DROP FUNCTION check_wallet_ledger_consistency();
DROP TRIGGER trg_journal_balanced ON journal_postings;
DROP FUNCTION check_journal_balance();
DROP TABLE journal_postings;
