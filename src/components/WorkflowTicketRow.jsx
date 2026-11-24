import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import useWorkflowStore from '../stores/workflowStore';
import useAuthStore from '../stores/authStore';
import useCodeStore from '../stores/codeStore';
import usePlanStore from '../stores/planStore';
import { confirmDialog } from '../stores/dialogStore';
import {
  acceptTicket,
  rejectTicket,
  deleteTicket,
  emitTicketAccepted,
  emitTicketRejected,
  emitTicketDeleted,
} from '../services/workflowService';
import { approveAndMergePlanPullRequest, closePlanPullRequest } from '../services/planPullRequestService';
import WorkflowTicketDiff from './WorkflowTicketDiff';

const STATUS_STYLES = {
  in_progress: { color: '#f3a85c', bg: 'rgba(243,168,92,0.12)', border: 'rgba(243,168,92,0.4)', label: 'In Progress' },
  to_review: { color: '#6ab9f5', bg: 'rgba(106,185,245,0.12)', border: 'rgba(106,185,245,0.4)', label: 'To Review' },
  committed: { color: '#7adc7e', bg: 'rgba(122,220,126,0.12)', border: 'rgba(122,220,126,0.4)', label: 'Committed' },
  merged: { color: '#4caf50', bg: 'rgba(76,175,80,0.12)', border: 'rgba(76,175,80,0.4)', label: 'Merged' },
  rejected: { color: '#f47864', bg: 'rgba(244,120,100,0.12)', border: 'rgba(244,120,100,0.4)', label: 'Rejected' },
};

function formatAge(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function WorkflowTicketRow({ ticket }) {
  const [expanded, setExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const statusMenuRef = useRef(null);
  const updateTicket = useWorkflowStore((s) => s.updateTicket);
  const removeTicket = useWorkflowStore((s) => s.removeTicket);
  const currentUserId = useAuthStore((s) => s.user?.uid || s.user?.sub);
  const repoOwner = useCodeStore((s) => s.repoOwner);
  const repoName = useCodeStore((s) => s.repoName);
  const selectedRepo = useCodeStore((s) => s.selectedRepo);

  const status = STATUS_STYLES[ticket.status] || STATUS_STYLES.in_progress;
  const isOwn = ticket.userId === currentUserId;
  const isPlanTicket = !!ticket.planTaskId;
  const canDecide = ticket.status === 'to_review' && (!isOwn || isPlanTicket);
  const canAccept = canDecide;
  const canReject = canDecide;
  const canMerge = isPlanTicket && ticket.status === 'committed' && !!ticket.githubPrNumber;
  const files = useMemo(() => ticket.filesTouched || [], [ticket.filesTouched]);
  const diffs = useMemo(() => ticket.diffs || [], [ticket.diffs]);
  const owner = repoOwner || selectedRepo?.owner?.login || null;
  const repo = repoName || selectedRepo?.name || null;
  const menuOpen = menuPosition !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (event) => {
      if (statusMenuRef.current?.contains(event.target)) return;
      setMenuPosition(null);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  const toggleStatusMenu = useCallback((e) => {
    e.stopPropagation();
    if (menuOpen) {
      setMenuPosition(null);
      return;
    }
    const button = statusMenuRef.current?.querySelector('.workflow-ticket-status');
    const rect = button?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 150;
    const menuHeight = 42;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = rect.bottom + menuHeight + 8 > window.innerHeight
      ? rect.top - menuHeight - 4
      : rect.bottom + 4;
    setMenuPosition({ top, left });
  }, [menuOpen]);

  const handleAccept = useCallback(async (e) => {
    e.stopPropagation();
    setActionLoading(true);
    setActionError(null);
    try {
      const updated = await acceptTicket(ticket.id);
      updateTicket(updated);
      emitTicketAccepted(ticket.id, currentUserId);

      if (!isPlanTicket && diffs.length > 0) {
        const csState = useCodeStore.getState();
        const pendingChanges = diffs.map((d) => ({
          filePath: d.filePath,
          original: d.original,
          proposed: d.proposed,
          fullContent: true,
          isWholeFileProposal: false,
          action: d.action || 'modify',
          request: `Accepted from workflow ticket by ${ticket.userName}`,
        }));
        csState.addPendingChanges(pendingChanges);
      }
    } catch (err) {
      console.warn('[WorkflowTicket] Accept failed:', err.message);
      setActionError(err.message || 'Failed to accept ticket');
    } finally {
      setActionLoading(false);
    }
  }, [ticket, diffs, currentUserId, updateTicket, isPlanTicket]);

  const handleReject = useCallback(async (e) => {
    e.stopPropagation();
    const reason = window.prompt('Why are you rejecting this ticket?', '');
    if (reason === null) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const result = await rejectTicket(ticket.id, reason);
      const { planTask, ...updatedTicket } = result || {};
      updateTicket(updatedTicket);
      if (planTask?.id) {
        usePlanStore.getState()._applyTaskUpdate(planTask);
      }
      emitTicketRejected(ticket.id, currentUserId);
      if (isPlanTicket && ticket.githubPrNumber && owner && repo) {
        await closePlanPullRequest({ owner, repo, ticket });
      }
    } catch (err) {
      console.warn('[WorkflowTicket] Reject failed:', err.message);
      setActionError(err.message || 'Failed to reject ticket');
    } finally {
      setActionLoading(false);
    }
  }, [ticket, currentUserId, updateTicket, isPlanTicket, owner, repo]);

  const handleRemove = useCallback(async (e) => {
    e.stopPropagation();
    setMenuPosition(null);
    const confirmed = await confirmDialog({
      title: 'Remove workflow ticket?',
      message: isPlanTicket
        ? 'This removes the ticket from the workflow and resets its plan task so it can run again. Any open pull request is closed.'
        : 'This removes the ticket from the workflow. Any open pull request is closed.',
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;

    setActionLoading(true);
    setActionError(null);
    try {
      const result = await deleteTicket(ticket.id);
      if (result?.planTask?.id) {
        usePlanStore.getState()._applyTaskUpdate(result.planTask);
      }
      removeTicket(ticket.id);
      emitTicketDeleted(ticket.id, ticket.spaceId);
      if (isPlanTicket && ticket.status !== 'merged' && ticket.githubPrNumber && owner && repo) {
        await closePlanPullRequest({ owner, repo, ticket });
      }
    } catch (err) {
      console.warn('[WorkflowTicket] Remove failed:', err.message);
      setActionError(err.message || 'Failed to remove ticket');
    } finally {
      setActionLoading(false);
    }
  }, [ticket, isPlanTicket, owner, repo, removeTicket]);

  const handleMerge = useCallback(async (e) => {
    e.stopPropagation();
    if (!owner || !repo) {
      setActionError('Repository coordinates are unavailable for this ticket');
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      const result = await approveAndMergePlanPullRequest({ owner, repo, ticket });
      if (!result.ok) {
        setActionError(result.error || 'Merge is blocked');
        return;
      }
      const { planTask, ...updatedTicket } = result.ticket || {};
      updateTicket(updatedTicket);
      if (planTask?.id) {
        usePlanStore.getState()._applyTaskUpdate(planTask);
      }
    } catch (err) {
      console.warn('[WorkflowTicket] Merge failed:', err.message);
      setActionError(err.message || 'Failed to merge pull request');
    } finally {
      setActionLoading(false);
    }
  }, [ticket, updateTicket, owner, repo]);

  return (
    <div className="workflow-ticket-row">
      <div className="workflow-ticket-header" onClick={() => setExpanded(!expanded)}>
        <div className="workflow-ticket-avatar">
          {ticket.userPicture ? (
            <img src={ticket.userPicture} alt="" className="workflow-ticket-avatar-img" />
          ) : (
            <div className="workflow-ticket-avatar-fallback">
              {(ticket.userName || '?')[0].toUpperCase()}
            </div>
          )}
        </div>

        <div className="workflow-ticket-info">
          <div className="workflow-ticket-topline">
            <span className="workflow-ticket-user">{ticket.userName || 'Unknown'}</span>
            {isPlanTicket && <span className="workflow-ticket-plan-badge">Plan</span>}
            <span className="workflow-ticket-time">{formatAge(ticket.createdAt)}</span>
          </div>
          <div className="workflow-ticket-preview">{ticket.promptPreview || '(no prompt)'}</div>
          {files.length > 0 && (
            <div className="workflow-ticket-files">
              {files.slice(0, 4).map((f) => (
                <span key={f} className="workflow-ticket-file-tag">{f.split('/').pop()}</span>
              ))}
              {files.length > 4 && <span className="workflow-ticket-file-more">+{files.length - 4}</span>}
            </div>
          )}
        </div>

        <div
          className="workflow-ticket-status-wrap"
          ref={statusMenuRef}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="workflow-ticket-status workflow-ticket-status-button"
            style={{ color: status.color, background: status.bg, borderColor: status.border }}
            onClick={toggleStatusMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Ticket actions"
          >
            {status.label}
            <span className="workflow-ticket-status-caret">{'\u25BE'}</span>
          </button>
          {menuPosition && (
            <div
              className="workflow-ticket-status-menu"
              role="menu"
              style={{ top: menuPosition.top, left: menuPosition.left }}
            >
              <button
                type="button"
                role="menuitem"
                className="workflow-ticket-status-remove"
                onClick={handleRemove}
                disabled={actionLoading}
              >
                {actionLoading ? 'Removing...' : 'Remove'}
              </button>
            </div>
          )}
        </div>

        <div className="workflow-ticket-actions">
          {ticket.githubPrUrl && (
            <a
              className="workflow-ticket-pr-link"
              href={ticket.githubPrUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              PR #{ticket.githubPrNumber}
            </a>
          )}
          {canAccept && (
            <button
              className="workflow-ticket-btn workflow-ticket-btn-accept"
              onClick={handleAccept}
              disabled={actionLoading}
              title="Accept changes"
            >
              {actionLoading ? '...' : 'Accept'}
            </button>
          )}
          {canMerge && (
            <button
              className="workflow-ticket-btn workflow-ticket-btn-accept"
              onClick={handleMerge}
              disabled={actionLoading}
              title="Approve and merge the pull request"
            >
              {actionLoading ? '...' : 'Merge PR'}
            </button>
          )}
          {canReject && (
            <button
              className="workflow-ticket-btn workflow-ticket-btn-reject"
              onClick={handleReject}
              disabled={actionLoading}
              title="Reject changes"
            >
              {actionLoading ? '...' : 'Reject'}
            </button>
          )}
          <span className="workflow-ticket-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
        </div>
      </div>

      {actionError && <div className="workflow-ticket-action-error">{actionError}</div>}

      {expanded && (
        <div className="workflow-ticket-expanded">
          <div className="workflow-ticket-prompt-full">
            <div className="workflow-ticket-section-label">Full Prompt</div>
            <div className="workflow-ticket-prompt-text">{ticket.promptFull || ticket.promptPreview}</div>
          </div>

          {ticket.githubBranch && (
            <div className="workflow-ticket-pr-info">
              <div className="workflow-ticket-section-label">Pull Request</div>
              <div className="workflow-ticket-pr-meta">
                <span>{ticket.githubBranch}</span>
                <span className="workflow-ticket-pr-arrow">→</span>
                <span>{ticket.githubBaseBranch || 'default'}</span>
                {ticket.githubPrState && (
                  <span className="workflow-ticket-pr-state">{ticket.githubPrState}</span>
                )}
              </div>
              {ticket.githubPrUrl && (
                <a
                  className="workflow-ticket-pr-expanded-link"
                  href={ticket.githubPrUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request #{ticket.githubPrNumber}
                </a>
              )}
            </div>
          )}

          {diffs.length > 0 && (
            <div className="workflow-ticket-diffs">
              <div className="workflow-ticket-section-label">Changes ({diffs.length} file{diffs.length !== 1 ? 's' : ''})</div>
              {diffs.map((d) => (
                <div key={d.filePath} className="workflow-ticket-diff-file">
                  <div className="workflow-ticket-diff-path">{d.filePath}</div>
                  <WorkflowTicketDiff original={d.original} proposed={d.proposed} />
                </div>
              ))}
            </div>
          )}

          {diffs.length === 0 && ticket.status === 'in_progress' && (
            <div className="workflow-ticket-no-diffs">No changes yet — task is still in progress.</div>
          )}
        </div>
      )}
    </div>
  );
}
