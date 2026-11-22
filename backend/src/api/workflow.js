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

  try {
    const result = await pool.query(
      `INSERT INTO workflow_tickets
         (space_id, user_id, user_name, user_picture, prompt_preview, prompt_full, files_touched, diffs)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
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
      ]
    );
    res.status(201).json(serializeTicket(result.rows[0]));
  } catch (err) {
    console.error('Create workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to create workflow ticket' });
  }
});

ticketItemRouter.patch('/', async (req, res) => {
  const { status, filesTouched, diffs } = req.body || {};
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Invalid workflow ticket status' });
  }
  if (filesTouched !== undefined && !Array.isArray(filesTouched)) {
    return res.status(400).json({ error: 'filesTouched must be an array' });
  }
  if (diffs !== undefined && !Array.isArray(diffs)) {
    return res.status(400).json({ error: 'diffs must be an array' });
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
           committed_at = CASE
             WHEN $1 = 'committed' THEN COALESCE(committed_at, NOW())
             WHEN $1 IN ('in_progress', 'to_review', 'rejected') THEN NULL
             ELSE committed_at
           END,
           updated_at = NOW()
       WHERE id = $4 AND space_id = $5
       RETURNING *`,
      [status ?? null, filesJson, diffsJson, req.ticket.id, req.ticket.space_id]
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
       WHERE id = $1 AND space_id = $2
       RETURNING *`,
      [req.ticket.id, req.ticket.space_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workflow ticket not found' });
    }
    res.json(serializeTicket(result.rows[0]));
  } catch (err) {
    console.error('Accept workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to accept workflow ticket' });
  }
});

ticketItemRouter.post('/reject', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE workflow_tickets
       SET status = 'rejected', committed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND space_id = $2
       RETURNING *`,
      [req.ticket.id, req.ticket.space_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workflow ticket not found' });
    }
    res.json(serializeTicket(result.rows[0]));
  } catch (err) {
    console.error('Reject workflow ticket error:', err);
    res.status(500).json({ error: 'Failed to reject workflow ticket' });
  }
});
