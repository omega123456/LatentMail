CREATE INDEX operations_failed_durable ON operations(account_id, created_at) WHERE status='failed' AND kind IN ('send','draft');
