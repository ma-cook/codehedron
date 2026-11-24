import pool from '../db.js';
import { serializeTicket } from '../api/workflow.js';

const TICKET_EVENTS = [
  'workflow:ticket:created',
  'workflow:ticket:updated',
  'workflow:ticket:accepted',
  'workflow:ticket:rejected',
];

export function registerWorkflowHandlers(io, socket) {
  socket.on('workflow:ticket:deleted', ({ ticketId, spaceId } = {}) => {
    if (!ticketId || !spaceId) return;
    if (typeof ticketId !== 'string' || typeof spaceId !== 'string') return;
    socket.to(`space:${spaceId}`).emit('workflow:ticket:deleted', { ticketId, spaceId });
  });

  for (const event of TICKET_EVENTS) {
    socket.on(event, async (payload = {}) => {
      const ticketId = payload.ticket?.id || payload.ticketId;
      if (!ticketId || typeof ticketId !== 'string') return;

      try {
        const result = await pool.query(
          `SELECT * FROM workflow_tickets WHERE id = $1`,
          [ticketId]
        );
        const ticket = result.rows[0];
        if (!ticket) return;

        const message = { ticket: serializeTicket(ticket) };
        if (payload.userId) message.userId = payload.userId;
        socket.to(`space:${ticket.space_id}`).emit(event, message);
      } catch (err) {
        console.error(`Workflow ${event} error:`, err);
      }
    });
  }
}
