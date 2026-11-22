CREATE TABLE IF NOT EXISTS workflow_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id        UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  user_name       TEXT NOT NULL,
  user_picture    TEXT,
  prompt_preview  TEXT NOT NULL,
  prompt_full     TEXT,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'to_review', 'committed', 'merged', 'rejected')),
  files_touched   JSONB NOT NULL DEFAULT '[]'::jsonb,
  diffs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  committed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_tickets_space_created
  ON workflow_tickets(space_id, created_at DESC);
