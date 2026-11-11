-- Webhook delivery outbox (v2 hardening). Events are persisted first, then a
-- background worker delivers them with retry/backoff; exhausted attempts become
-- a dead-letter (status='failed'). Gives durability, retry, history and DLQ.
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event           TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT,
    response_status INT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ
);

CREATE INDEX idx_wh_deliveries_due ON webhook_deliveries (next_attempt_at)
    WHERE status = 'pending';
CREATE INDEX idx_wh_deliveries_org ON webhook_deliveries (org_id, created_at DESC);
