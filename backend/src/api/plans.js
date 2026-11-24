import { Router } from 'express';
import { randomUUID } from 'crypto';
import pool from '../db.js';

export const router = Router();
export const planItemRouter = Router({ mergeParams: true });

export function resolvePlanSpace(req, res, next) {
  const spaceId = req.body?.spaceId || req.query?.spaceId;
  if (!spaceId) return res.status(400).json({ error: 'spaceId is required' });
  next();
}

export async function resolvePlanItem(req, res, next) {
  const { planId } = req.params;
  if (!planId) return res.status(400).json({ error: 'planId is required' });
  try {
    const result = await pool.query(
      `SELECT * FROM plans WHERE id = $1`,
      [planId]
    );
    const plan = result.rows[0];
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    req.plan = plan;
    req.body = req.body || {};
    req.body.spaceId = plan.space_id;
    next();
  } catch (err) {
    console.error('Resolve plan item error:', err);
    res.status(500).json({ error: 'Failed to resolve plan' });
  }
}

// GET /api/plans?spaceId=X — get active plan + tasks for a space
router.get('/', async (req, res) => {
  const spaceId = req.query.spaceId || req.body?.spaceId;
  if (!spaceId) return res.status(400).json({ error: 'spaceId is required' });

  try {
    // Get or create the active plan for this space
    let result = await pool.query(
      `SELECT * FROM plans WHERE space_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [spaceId]
    );

    let plan;
    if (result.rows.length === 0) {
      if (!req.user || req.guest) return res.json(null);
      // Auto-create a plan for the space
      result = await pool.query(
        `INSERT INTO plans (space_id, title) VALUES ($1, 'Plan') RETURNING *`,
        [spaceId]
      );
      plan = result.rows[0];
    } else {
      plan = result.rows[0];
    }

    // Get all tasks for the plan
    const tasksResult = await pool.query(
      `SELECT * FROM plan_tasks WHERE plan_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [plan.id]
    );

    res.json({ ...plan, tasks: tasksResult.rows });
  } catch (err) {
    console.error('Get plan error:', err);
    res.status(500).json({ error: 'Failed to get plan' });
  }
});

// POST /api/plans — create a new plan (replaces existing for the space)
router.post('/', async (req, res) => {
  const { spaceId, title } = req.body;
  if (!spaceId) return res.status(400).json({ error: 'spaceId is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const activeTask = await client.query(
      `SELECT id FROM plan_tasks
       WHERE space_id = $1 AND status IN ('working_on', 'to_review')
       LIMIT 1`,
      [spaceId]
    );
    if (activeTask.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Finish or reject the active plan task before creating a new plan',
      });
    }

    // Delete existing plan and its tasks for this space
    const existing = await client.query(
      `SELECT id FROM plans WHERE space_id = $1`,
      [spaceId]
    );
    if (existing.rows.length > 0) {
      const oldPlanId = existing.rows[0].id;
      await client.query(`DELETE FROM plan_tasks WHERE plan_id = $1`, [oldPlanId]);
      await client.query(`DELETE FROM plans WHERE id = $1`, [oldPlanId]);
    }

    // Create new plan
    const result = await client.query(
      `INSERT INTO plans (space_id, title) VALUES ($1, $2) RETURNING *`,
      [spaceId, title || 'Plan']
    );

    await client.query('COMMIT');
    const plan = result.rows[0];
    res.status(201).json({ ...plan, tasks: [] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create plan error:', err);
    res.status(500).json({ error: 'Failed to create plan' });
  } finally {
    client.release();
  }
});

// PATCH /api/plans/:planId — update plan title
planItemRouter.patch('/', async (req, res) => {
  const { title } = req.body;
  const plan = req.plan;
  try {
    const result = await pool.query(
      `UPDATE plans SET title = COALESCE($1, title), updated_at = NOW()
       WHERE id = $2 AND space_id = $3 RETURNING *`,
      [title, plan.id, plan.space_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update plan error:', err);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// POST /api/plans/:planId/tasks — add a task
planItemRouter.post('/tasks', async (req, res) => {
  const { text, userId, userName, userPicture, independent } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  const plan = req.plan;

  try {
    const previous = independent ? null : await pool.query(
      `SELECT id FROM plan_tasks
       WHERE plan_id = $1
       ORDER BY sort_order DESC, created_at DESC
       LIMIT 1`,
      [plan.id]
    );

    const maxOrder = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM plan_tasks WHERE plan_id = $1`,
      [plan.id]
    );

    const dependsOn = previous?.rows[0]?.id ? [previous.rows[0].id] : [];

    const result = await pool.query(
      `INSERT INTO plan_tasks
         (plan_id, space_id, user_id, user_name, user_picture, text, sort_order, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[]) RETURNING *`,
      [
        plan.id,
        plan.space_id,
        userId || 'anonymous',
        userName || 'Anonymous',
        userPicture || null,
        text,
        maxOrder.rows[0].next_order,
        dependsOn,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Add plan task error:', err);
    res.status(500).json({ error: 'Failed to add task' });
  }
});

// PATCH /api/plans/:planId/tasks/:taskId — update task (status, text)
planItemRouter.patch('/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const { status, lastError } = req.body || {};
  const plan = req.plan;
  const hasStatus = status !== undefined;
  const hasError = lastError !== undefined;

  if (!hasStatus && !hasError) {
    return res.status(400).json({ error: 'status or lastError is required' });
  }
  if (hasStatus && status !== 'completed' && status !== 'todo') {
    return res.status(400).json({ error: 'status must be "completed" or "todo"' });
  }
  if (hasError && lastError !== null && typeof lastError !== 'string') {
    return res.status(400).json({ error: 'lastError must be a string or null' });
  }

  try {
    const result = await pool.query(
      `UPDATE plan_tasks
       SET status = COALESCE($3, status),
           completed_at = CASE
             WHEN $3 = 'completed' THEN NOW()
             WHEN $3 = 'todo' THEN NULL
             ELSE completed_at
           END,
           last_error = CASE WHEN $4::boolean THEN $5 ELSE last_error END,
           claimed_by = CASE WHEN $3 IN ('completed', 'todo') THEN NULL ELSE claimed_by END,
           claimed_at = CASE WHEN $3 IN ('completed', 'todo') THEN NULL ELSE claimed_at END,
           claim_token = CASE WHEN $3 IN ('completed', 'todo') THEN NULL ELSE claim_token END,
           ticket_id = CASE WHEN $3 = 'todo' THEN NULL ELSE ticket_id END
       WHERE id = $1 AND plan_id = $2
       RETURNING *`,
      [taskId, plan.id, status ?? null, hasError, lastError ?? null]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update plan task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

planItemRouter.post('/claim-next', async (req, res) => {
  if (!req.user || req.guest) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const plan = req.plan;
  const retryTaskId = typeof req.body?.retryTaskId === 'string' ? req.body.retryTaskId : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [plan.id]);

    await client.query(
      `WITH stale AS (
         UPDATE plan_tasks
         SET status = 'todo',
             claimed_by = NULL,
             claimed_at = NULL,
             claim_token = NULL,
             completed_at = NULL,
             ticket_id = NULL,
             last_error = COALESCE(last_error, 'Run interrupted')
         WHERE plan_id = $1
           AND status = 'working_on'
           AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '2 minutes')
         RETURNING id
       )
       UPDATE workflow_tickets
       SET status = 'rejected', updated_at = NOW()
       WHERE plan_task_id IN (SELECT id FROM stale)
         AND status IN ('in_progress', 'to_review')`,
      [plan.id]
    );

    const active = await client.query(
      `SELECT id, status FROM plan_tasks
       WHERE plan_id = $1 AND status IN ('working_on', 'to_review')
       ORDER BY sort_order ASC, created_at ASC
       LIMIT 1`,
      [plan.id]
    );

    if (active.rows.length > 0) {
      await client.query('COMMIT');
      return res.status(409).json({
        error: 'The plan already has an active task',
        activeTask: active.rows[0],
      });
    }

    let task = null;
    if (retryTaskId) {
      const retry = await client.query(
        `SELECT t.* FROM plan_tasks t
         WHERE t.id = $2
           AND t.plan_id = $1
           AND t.status = 'todo'
           AND NOT EXISTS (
             SELECT 1 FROM plan_tasks d
             WHERE d.id = ANY(t.depends_on) AND d.status <> 'completed'
           )
         FOR UPDATE SKIP LOCKED`,
        [plan.id, retryTaskId]
      );
      task = retry.rows[0] || null;
    }

    if (!task) {
      const next = await client.query(
        `SELECT t.* FROM plan_tasks t
         WHERE t.plan_id = $1
           AND t.status = 'todo'
           AND NOT EXISTS (
             SELECT 1 FROM plan_tasks d
             WHERE d.id = ANY(t.depends_on) AND d.status <> 'completed'
           )
         ORDER BY t.sort_order ASC, t.created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [plan.id]
      );
      task = next.rows[0] || null;
    }

    if (!task) {
      await client.query('COMMIT');
      return res.json({ task: null, claimToken: null });
    }

    const claimToken = randomUUID();
    const claimed = await client.query(
      `UPDATE plan_tasks
       SET status = 'working_on',
           claimed_by = $1,
           claimed_at = NOW(),
           claim_token = $2::uuid,
           completed_at = NULL,
           ticket_id = NULL,
           last_error = NULL
       WHERE id = $3
       RETURNING *`,
      [req.user.sub, claimToken, task.id]
    );

    await client.query('COMMIT');
    res.json({ task: claimed.rows[0], claimToken });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Claim plan task error:', err);
    res.status(500).json({ error: 'Failed to claim task' });
  } finally {
    client.release();
  }
});

planItemRouter.post('/tasks/:taskId/heartbeat', async (req, res) => {
  const { taskId } = req.params;
  const { claimToken } = req.body || {};
  if (!claimToken || typeof claimToken !== 'string') {
    return res.status(400).json({ error: 'claimToken is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE plan_tasks
       SET claimed_at = NOW()
       WHERE id = $1
         AND plan_id = $2
         AND status = 'working_on'
         AND claim_token = $3::uuid
       RETURNING *`,
      [taskId, req.plan.id, claimToken]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Task claim is no longer active' });
    }
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error('Heartbeat plan task error:', err);
    res.status(500).json({ error: 'Failed to heartbeat task' });
  }
});

planItemRouter.post('/tasks/:taskId/finish', async (req, res) => {
  const { taskId } = req.params;
  const { claimToken, ticketId } = req.body || {};
  if (!claimToken || !ticketId) {
    return res.status(400).json({ error: 'claimToken and ticketId are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ticket = await client.query(
      `SELECT id FROM workflow_tickets
       WHERE id = $1 AND space_id = $2
         AND (plan_task_id IS NULL OR plan_task_id = $3)
         AND status IN ('in_progress', 'to_review', 'committed')`,
      [ticketId, req.plan.space_id, taskId]
    );
    if (ticket.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Workflow ticket not found in this space' });
    }

    const existing = await client.query(
      `SELECT * FROM plan_tasks
       WHERE id = $1 AND plan_id = $2 AND status = 'to_review' AND ticket_id = $3
       FOR UPDATE`,
      [taskId, req.plan.id, ticketId]
    );
    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE workflow_tickets
         SET plan_task_id = COALESCE(plan_task_id, $1), updated_at = NOW()
         WHERE id = $2 AND space_id = $3`,
        [taskId, ticketId, req.plan.space_id]
      );
      await client.query('COMMIT');
      return res.json({ task: existing.rows[0] });
    }

    const result = await client.query(
      `UPDATE plan_tasks
       SET status = 'to_review',
           ticket_id = $1,
           claimed_by = NULL,
           claimed_at = NULL,
           claim_token = NULL,
           completed_at = NULL
       WHERE id = $2
         AND plan_id = $3
         AND status = 'working_on'
         AND claim_token = $4::uuid
       RETURNING *`,
      [ticketId, taskId, req.plan.id, claimToken]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Task claim is no longer active' });
    }

    await client.query(
      `UPDATE workflow_tickets
       SET plan_task_id = COALESCE(plan_task_id, $1), updated_at = NOW()
       WHERE id = $2 AND space_id = $3`,
      [taskId, ticketId, req.plan.space_id]
    );

    await client.query('COMMIT');
    res.json({ task: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Finish plan task error:', err);
    res.status(500).json({ error: 'Failed to finish task' });
  } finally {
    client.release();
  }
});

planItemRouter.post('/tasks/:taskId/release', async (req, res) => {
  const { taskId } = req.params;
  const { claimToken, error } = req.body || {};
  if (!claimToken || typeof claimToken !== 'string') {
    return res.status(400).json({ error: 'claimToken is required' });
  }
  if (error !== undefined && error !== null && typeof error !== 'string') {
    return res.status(400).json({ error: 'error must be a string or null' });
  }

  try {
    const result = await pool.query(
      `UPDATE plan_tasks
       SET status = 'todo',
           claimed_by = NULL,
           claimed_at = NULL,
           claim_token = NULL,
           completed_at = NULL,
           ticket_id = NULL,
           last_error = $1
       WHERE id = $2
         AND plan_id = $3
         AND status = 'working_on'
         AND claim_token = $4::uuid
       RETURNING *`,
      [error || null, taskId, req.plan.id, claimToken]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Task claim is no longer active' });
    }
    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error('Release plan task error:', err);
    res.status(500).json({ error: 'Failed to release task' });
  }
});

// DELETE /api/plans/:planId/tasks/:taskId — remove a task
planItemRouter.delete('/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  const plan = req.plan;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM plan_tasks WHERE id = $1 AND plan_id = $2 RETURNING id`,
      [taskId, plan.id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }

    await client.query(
      `UPDATE plan_tasks
       SET depends_on = array_remove(depends_on, $1::uuid)
       WHERE plan_id = $2 AND $1::uuid = ANY(depends_on)`,
      [taskId, plan.id]
    );

    await client.query('COMMIT');
    res.json({ deleted: true, taskId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete plan task error:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  } finally {
    client.release();
  }
});
