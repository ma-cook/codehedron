DO $$
DECLARE
  con record;
BEGIN
  IF to_regclass('plan_tasks') IS NULL THEN
    RETURN;
  END IF;

  FOR con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'plan_tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE plan_tasks DROP CONSTRAINT %I', con.conname);
  END LOOP;

  ALTER TABLE plan_tasks
    ADD COLUMN IF NOT EXISTS claimed_by TEXT,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS depends_on UUID[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS ticket_id UUID,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

  ALTER TABLE plan_tasks
    ADD CONSTRAINT plan_tasks_status_check
    CHECK (status IN ('todo', 'working_on', 'to_review', 'completed'));

  WITH ordered AS (
    SELECT
      id,
      lag(id) OVER (PARTITION BY plan_id ORDER BY sort_order ASC, created_at ASC) AS previous_id
    FROM plan_tasks
  )
  UPDATE plan_tasks t
  SET depends_on = ARRAY[o.previous_id]
  FROM ordered o
  WHERE t.id = o.id
    AND o.previous_id IS NOT NULL
    AND coalesce(cardinality(t.depends_on), 0) = 0;

  CREATE INDEX IF NOT EXISTS idx_plan_tasks_claim
    ON plan_tasks(plan_id, status, sort_order);

  IF to_regclass('workflow_tickets') IS NOT NULL THEN
    ALTER TABLE workflow_tickets
      ADD COLUMN IF NOT EXISTS plan_task_id UUID,
      ADD COLUMN IF NOT EXISTS github_branch TEXT,
      ADD COLUMN IF NOT EXISTS github_base_branch TEXT,
      ADD COLUMN IF NOT EXISTS github_pr_number INTEGER,
      ADD COLUMN IF NOT EXISTS github_pr_url TEXT,
      ADD COLUMN IF NOT EXISTS github_merge_commit_sha TEXT,
      ADD COLUMN IF NOT EXISTS github_pr_state TEXT;

    CREATE INDEX IF NOT EXISTS idx_workflow_tickets_plan_task
      ON workflow_tickets(plan_task_id);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'workflow_tickets'::regclass
        AND conname = 'workflow_tickets_plan_task_id_fkey'
    ) THEN
      ALTER TABLE workflow_tickets
        ADD CONSTRAINT workflow_tickets_plan_task_id_fkey
        FOREIGN KEY (plan_task_id) REFERENCES plan_tasks(id) ON DELETE SET NULL;
    END IF;
  END IF;

  IF to_regclass('workflow_tickets') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'plan_tasks'::regclass
         AND conname = 'plan_tasks_ticket_id_fkey'
     ) = false
  THEN
    ALTER TABLE plan_tasks
      ADD CONSTRAINT plan_tasks_ticket_id_fkey
      FOREIGN KEY (ticket_id) REFERENCES workflow_tickets(id) ON DELETE SET NULL;
  END IF;
END $$;
