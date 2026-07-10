-- Webhook-delivery idempotency (Track N). A queue (QStash) or GitHub's own webhook
-- redelivery can cause the same X-GitHub-Delivery to reach the pipeline twice; this
-- table lets the route claim a delivery exactly once before any pipeline work starts,
-- in BOTH the queued and the after() fallback path (docs/PLAN_V2.md §3, §8).
CREATE TABLE processed_deliveries (
    delivery_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
