import { Router } from 'express';
import pool from '../db.js';

export const router = Router();
export const ticketItemRouter = Router({ mergeParams: true });

const VALID_STATUSES = new Set([
  'in_progress',
  'to_review',
  'committed',
  'merged',
  'rejected',
]);

const MAX_PROMPT_LENGTH = 200000;
const MAX_FILES = 500;
const MAX_DIFFS = 500;

export function serializeTicket(row) {
  return {
    id: row.id,
    spaceId: row.space_id,
    userId: row.user_id,
    userName: row.user_name,
    userPicture: row.user_picture,
    promptPreview: row.prompt_preview,
    promptFull: row.prompt_full,
    status: row.status,
    filesTouched: row.files_touched || [],
    diffs: row.diffs || [],
    planTaskId: row.plan_task_id || null,
    githubBranch: row.github_branch || null,
    githubBaseBranch: row.github_base_branch || null,
    githubPrNumber: row.github_pr_number || null,
    githubPrUrl: row.github_pr_url || null,
    githubMergeCommitSha: row.github_merge_commit_sha || null,
    githubPrState: row.github_pr_state || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
  };
}

export function resolveWorkflowSpace(req, res, next) {
  const spaceId = req.body?.spaceId || req.query?.spaceId;
  if (!spaceId || typeof spaceId !== 'string') {
    return res.status(400).json({ error: 'spaceId is required' });
  }
  next();
}

export async function resolveWorkflowTicket(req, res, next) {
  const { ticketId } = req.params;
  if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });
  try {
    const result = await pool.query(
      `SELECT * FROM workflow_tickets WHERE id = $1`,
      [ticketId]
    );
    const ticket = result.rows[0];
    if (!ticket) return res.status(404).json({ error: 'Workflow ticket not found' });
    req.ticket = ticket;
    req.body = req.body || {};
    req.body.spaceId = ticket.space_id;
    next();
  } catch (err) {
    console.error('Resolve workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to resolve workflow ticket' });
  }
}

router.get('/', async (req, res) => {
  const spaceId = req.query.spaceId || req.body?.spaceId;
  if (!spaceId) return res.status(400).json({ error: 'spaceId is required' });

  try {
    const result = await pool.query(
      `SELECT * FROM workflow_tickets
       WHERE space_id = $1
       ORDER BY created_at DESC`,
      [spaceId]
    );
    res.json(result.rows.map(serializeTicket));
  } catch (err) {
    console.error('List workflow tickets error:', err);
    res.status(500).json({ error: 'Failed to list workflow tickets' });
  }
});

router.post('/', async (req, res) => {
  if (!req.user || req.guest) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const rawFull = typeof req.body?.promptFull === 'string' ? req.body.promptFull : '';
  const rawPreview = typeof req.body?.promptPreview === 'string' ? req.body.promptPreview : '';
  const promptFull = rawFull.slice(0, MAX_PROMPT_LENGTH);
  const promptPreview = (rawPreview || promptFull).slice(0, 120);
  if (!promptPreview) return res.status(400).json({ error: 'promptPreview is required' });

  const filesTouched = Array.isArray(req.body?.filesTouched)
    ? req.body.filesTouched.filter((file) => typeof file === 'string').slice(0, MAX_FILES)
    : [];
  const diffs = Array.isArray(req.body?.diffs)
    ? req.body.diffs.filter((diff) => diff && typeof diff === 'object').slice(0, MAX_DIFFS)
    : [];

  const userId = req.user.sub;
  const userName = req.user.name || req.user.email || 'Anonymous';
  const userPicture = req.user.picture || null;
  const planTaskId = typeof req.body?.planTaskId === 'string' ? req.body.planTaskId : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (planTaskId) {
      const claim = await client.query(
        `SELECT id FROM plan_tasks
         WHERE id = $1 AND space_id = $2 AND status = 'working_on' AND claimed_by = $3
         FOR UPDATE`,
        [planTaskId, req.body.spaceId, userId]
      );
      if (claim.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Plan task is not claimed by this user' });
      }
    }

    const result = await client.query(
      `INSERT INTO workflow_tickets
         (space_id, user_id, user_name, user_picture, prompt_preview, prompt_full,
          files_touched, diffs, plan_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING *`,
      [
        req.body.spaceId,
        userId,
        userName,
        userPicture,
        promptPreview,
        promptFull,
        JSON.stringify(filesTouched),
        JSON.stringify(diffs),
        planTaskId,
      ]
    );

    if (planTaskId) {
      await client.query(
        `UPDATE plan_tasks SET ticket_id = $1 WHERE id = $2`,
        [result.rows[0].id, planTaskId]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(serializeTicket(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to create workflow ticket' });
  } finally {
    client.release();
  }
});

ticketItemRouter.patch('/', async (req, res) => {
  const {
    status,
    filesTouched,
    diffs,
    githubBranch,
    githubBaseBranch,
    githubPrNumber,
    githubPrUrl,
    githubPrState,
    githubMergeCommitSha,
  } = req.body || {};

  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid workflow ticket status' });
  }
  if (status === 'merged' && req.ticket.plan_task_id) {
    return res.status(400).json({ error: 'Use the merged endpoint for plan-linked tickets' });
  }
  if (
    status === 'to_review'
    && req.ticket.plan_task_id
    && !['in_progress', 'to_review'].includes(req.ticket.status)
  ) {
    return res.status(409).json({ error: 'Plan ticket can no longer be submitted for review' });
  }
  if (filesTouched !== undefined && !Array.isArray(filesTouched)) {
    return res.status(400).json({ error: 'filesTouched must be an array' });
  }
  if (diffs !== undefined && !Array.isArray(diffs)) {
    return res.status(400).json({ error: 'diffs must be an array' });
  }
  if (githubPrNumber !== undefined && githubPrNumber !== null && !Number.isInteger(githubPrNumber)) {
    return res.status(400).json({ error: 'githubPrNumber must be an integer or null' });
  }
  for (const [name, value] of Object.entries({
    githubBranch,
    githubBaseBranch,
    githubPrUrl,
    githubPrState,
    githubMergeCommitSha,
  })) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return res.status(400).json({ error: `${name} must be a string or null` });
    }
  }

  const filesJson = filesTouched === undefined
    ? null
    : JSON.stringify(filesTouched.filter((file) => typeof file === 'string').slice(0, MAX_FILES));
  const diffsJson = diffs === undefined
    ? null
    : JSON.stringify(diffs.filter((diff) => diff && typeof diff === 'object').slice(0, MAX_DIFFS));

  try {
    const result = await pool.query(
      `UPDATE workflow_tickets
       SET status = COALESCE($1, status),
           files_touched = COALESCE($2::jsonb, files_touched),
           diffs = COALESCE($3::jsonb, diffs),
           github_branch = COALESCE($4, github_branch),
           github_base_branch = COALESCE($5, github_base_branch),
           github_pr_number = COALESCE($6, github_pr_number),
           github_pr_url = COALESCE($7, github_pr_url),
           github_pr_state = COALESCE($8, github_pr_state),
           github_merge_commit_sha = COALESCE($9, github_merge_commit_sha),
           committed_at = CASE
             WHEN $1 = 'committed' THEN COALESCE(committed_at, NOW())
             WHEN $1 IN ('in_progress', 'to_review', 'rejected') THEN NULL
             ELSE committed_at
           END,
           updated_at = NOW()
       WHERE id = $10 AND space_id = $11
       RETURNING *`,
      [
        status ?? null,
        filesJson,
        diffsJson,
        githubBranch ?? null,
        githubBaseBranch ?? null,
        githubPrNumber ?? null,
        githubPrUrl ?? null,
        githubPrState ?? null,
        githubMergeCommitSha ?? null,
        req.ticket.id,
        req.ticket.space_id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workflow ticket not found' });
    }
    res.json(serializeTicket(result.rows[0]));
  } catch (err) {
    console.error('Update workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to update workflow ticket' });
  }
});

ticketItemRouter.post('/accept', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE workflow_tickets
       SET status = 'committed', committed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND space_id = $2 AND status IN ('to_review', 'committed')
       RETURNING *`,
      [req.ticket.id, req.ticket.space_id]
    );
    if (result.rows.length === 0) {
      if (req.ticket.status === 'merged') {
        return res.status(409).json({ error: 'Workflow ticket is already merged' });
      }
      return res.status(409).json({ error: 'Workflow ticket is not ready for acceptance' });
    }
    res.json(serializeTicket(result.rows[0]));
  } catch (err) {
    console.error('Accept workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to accept workflow ticket' });
  }
});

ticketItemRouter.post('/reject', async (req, res) => {
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim()
    : 'Rejected by user';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE workflow_tickets
       SET status = 'rejected', committed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND space_id = $2 AND status <> 'merged'
       RETURNING *`,
      [req.ticket.id, req.ticket.space_id]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      if (req.ticket.status === 'merged') {
        return res.status(409).json({ error: 'A merged ticket cannot be rejected' });
      }
      return res.status(404).json({ error: 'Workflow ticket not found' });
    }

    let planTask = null;
    if (result.rows[0].plan_task_id) {
      const taskResult = await client.query(
        `UPDATE plan_tasks
         SET status = 'todo',
             completed_at = NULL,
             claimed_by = NULL,
             claimed_at = NULL,
             claim_token = NULL,
             ticket_id = NULL,
             last_error = $1
         WHERE id = $2
            AND space_id = $3
            AND status IN ('working_on', 'to_review')
            AND (ticket_id IS NULL OR ticket_id = $4)
         RETURNING *`,
        [reason, result.rows[0].plan_task_id, req.ticket.space_id, result.rows[0].id]
      );
      planTask = taskResult.rows[0] || null;
    }

    await client.query('COMMIT');
    res.json({ ...serializeTicket(result.rows[0]), planTask });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reject workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to reject workflow ticket' });
  } finally {
    client.release();
  }
});

ticketItemRouter.post('/merged', async (req, res) => {
  const mergeCommitSha = typeof req.body?.mergeCommitSha === 'string'
    ? req.body.mergeCommitSha
    : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query(
      `SELECT * FROM workflow_tickets WHERE id = $1 AND space_id = $2 FOR UPDATE`,
      [req.ticket.id, req.ticket.space_id]
    );
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Workflow ticket not found' });
    }

    const ticket = locked.rows[0];
    if (ticket.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A rejected ticket cannot be marked merged' });
    }
    if (ticket.status !== 'merged' && ticket.status !== 'committed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Workflow ticket must be accepted before merge' });
    }

    const result = ticket.status === 'merged'
      ? { rows: [ticket] }
      : await client.query(
        `UPDATE workflow_tickets
         SET status = 'merged',
             github_merge_commit_sha = COALESCE($1, github_merge_commit_sha),
             github_pr_state = 'merged',
             updated_at = NOW()
         WHERE id = $2 AND space_id = $3
         RETURNING *`,
        [mergeCommitSha, req.ticket.id, req.ticket.space_id]
      );

    let planTask = null;
    if (result.rows[0].plan_task_id) {
      const taskResult = await client.query(
        `UPDATE plan_tasks
         SET status = 'completed',
             completed_at = NOW(),
             claimed_by = NULL,
             claimed_at = NULL,
             claim_token = NULL,
             ticket_id = $1,
             last_error = NULL
         WHERE id = $2 AND space_id = $3
           AND status IN ('working_on', 'to_review')
           AND (ticket_id IS NULL OR ticket_id = $1)
         RETURNING *`,
        [result.rows[0].id, result.rows[0].plan_task_id, req.ticket.space_id]
      );
      planTask = taskResult.rows[0] || null;
    }

    await client.query('COMMIT');
    res.json({ ...serializeTicket(result.rows[0]), planTask });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Merge workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to mark workflow ticket merged' });
  } finally {
    client.release();
  }
});
