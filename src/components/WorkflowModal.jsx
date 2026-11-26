import { useState, useEffect, useCallback, useRef } from 'react';
import useWorkflowStore from '../stores/workflowStore';
import useSpaceManagerStore from '../stores/spaceManagerStore';
import usePlanStore from '../stores/planStore';
import useAuthStore from '../stores/authStore';
import useCodeStore from '../stores/codeStore';
import {
  getTickets,
  subscribeToTickets,
  acceptTicket,
  emitTicketAccepted,
} from '../services/workflowService';
import { approveAndMergePlanPullRequest } from '../services/planPullRequestService';
import WorkflowTicketRow from './WorkflowTicketRow';
import './WorkflowModal.css';

const TABS = [
  { key: null, label: 'All' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'to_review', label: 'To Review' },
  { key: 'committed', label: 'Committed' },
  { key: 'merged', label: 'Merged' },
  { key: 'rejected', label: 'Rejected' },
];

function isReviewTicket(ticket, spaceId, inFlight) {
  return ticket?.status === 'to_review' && ticket.spaceId === spaceId && !inFlight.has(ticket.id);
}

async function acceptAndMergeTicket(ticket, context) {
  const accepted = await acceptTicket(ticket.id);
  context.updateTicket(accepted);
  emitTicketAccepted(ticket.id, context.currentUserId);

  if (!ticket.planTaskId && Array.isArray(ticket.diffs) && ticket.diffs.length > 0) {
    const pendingChanges = ticket.diffs.map((d) => ({
      filePath: d.filePath,
      original: d.original,
      proposed: d.proposed,
      fullContent: true,
      isWholeFileProposal: false,
      action: d.action || 'modify',
      request: `Accepted from workflow ticket by ${ticket.userName}`,
    }));
    useCodeStore.getState().addPendingChanges(pendingChanges);
  }

  if (!ticket.planTaskId || !accepted.githubPrNumber) return accepted;
  if (!context.isEnabled()) return accepted;

  const owner = context.repoOwner || context.selectedRepo?.owner?.login || null;
  const repo = context.repoName || context.selectedRepo?.name || null;
  if (!owner || !repo) throw new Error('Repository coordinates are unavailable for this ticket');

  const result = await approveAndMergePlanPullRequest({ owner, repo, ticket: accepted });
  if (!result.ok) throw new Error(result.error || 'Merge is blocked');

  const { planTask, ...updatedTicket } = result.ticket || {};
  context.updateTicket(updatedTicket);
  if (planTask?.id) usePlanStore.getState()._applyTaskUpdate(planTask);
  return accepted;
}

export default function WorkflowModal() {
  const isOpen = useWorkflowStore((s) => s.isModalOpen);
  const setModalOpen = useWorkflowStore((s) => s.setModalOpen);
  const tickets = useWorkflowStore((s) => s.tickets);
  const setTickets = useWorkflowStore((s) => s.setTickets);
  const addTicket = useWorkflowStore((s) => s.addTicket);
  const updateTicket = useWorkflowStore((s) => s.updateTicket);
  const removeTicket = useWorkflowStore((s) => s.removeTicket);
  const isLoading = useWorkflowStore((s) => s.isLoading);
  const setIsLoading = useWorkflowStore((s) => s.setIsLoading);
  const spaceId = useSpaceManagerStore((s) => s.currentSpaceId);
  const refreshPlan = usePlanStore((s) => s.refreshPlan);
  const autoAcceptEnabled = useWorkflowStore((s) => s.autoAcceptEnabled);
  const toggleAutoAccept = useWorkflowStore((s) => s.toggleAutoAccept);
  const setAutoAcceptEnabled = useWorkflowStore((s) => s.setAutoAcceptEnabled);
  const currentUserId = useAuthStore((s) => s.user?.uid || s.user?.sub);
  const repoOwner = useCodeStore((s) => s.repoOwner);
  const repoName = useCodeStore((s) => s.repoName);
  const selectedRepo = useCodeStore((s) => s.selectedRepo);

  const [activeTab, setActiveTab] = useState(null);
  const [autoAcceptTick, setAutoAcceptTick] = useState(0);
  const autoAcceptEnabledRef = useRef(autoAcceptEnabled);
  const autoAcceptLoopRef = useRef(false);
  const autoAcceptInFlightRef = useRef(new Set());
  autoAcceptEnabledRef.current = autoAcceptEnabled;

  useEffect(() => {
    if (!isOpen || !spaceId) return;
    let cancelled = false;
    setIsLoading(true);
    getTickets(spaceId)
      .then((fetched) => {
        if (!cancelled) setTickets(fetched);
      })
      .catch((err) => {
        console.warn('[WorkflowModal] Failed to fetch tickets:', err.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, spaceId, setTickets, setIsLoading]);

  useEffect(() => {
    if (!spaceId) return;
    const applyTicket = (ticket) => {
      if (!ticket) return;
      updateTicket(ticket);
      if (ticket.planTaskId) refreshPlan();
    };
    const unsub = subscribeToTickets(spaceId, {
      onCreated: addTicket,
      onUpdated: applyTicket,
      onAccepted: (data) => applyTicket(data.ticket),
      onRejected: (data) => applyTicket(data.ticket),
      onDeleted: (data) => {
        if (!data?.ticketId) return;
        removeTicket(data.ticketId);
        refreshPlan();
      },
    });
    return unsub;
  }, [spaceId, addTicket, updateTicket, removeTicket, refreshPlan]);

  useEffect(() => {
    if (!autoAcceptEnabled || !spaceId || isLoading || autoAcceptLoopRef.current) return;

    const inFlight = autoAcceptInFlightRef.current;
    autoAcceptLoopRef.current = true;

    (async () => {
      try {
        while (autoAcceptEnabledRef.current) {
          const next = useWorkflowStore.getState().tickets.find((t) => isReviewTicket(t, spaceId, inFlight));
          if (!next) break;
          inFlight.add(next.id);
          try {
            await acceptAndMergeTicket(next, {
              currentUserId,
              updateTicket,
              repoOwner,
              repoName,
              selectedRepo,
              isEnabled: () => autoAcceptEnabledRef.current,
            });
          } catch (err) {
            console.warn('[WorkflowModal] Auto-accept failed:', err.message);
            setAutoAcceptEnabled(false);
            break;
          } finally {
            inFlight.delete(next.id);
          }
        }
      } finally {
        autoAcceptLoopRef.current = false;
      }

      if (
        autoAcceptEnabledRef.current &&
        useWorkflowStore.getState().tickets.some((t) => isReviewTicket(t, spaceId, inFlight))
      ) {
        setAutoAcceptTick((tick) => tick + 1);
      }
    })();
  }, [
    autoAcceptEnabled,
    autoAcceptTick,
    tickets,
    isLoading,
    spaceId,
    currentUserId,
    updateTicket,
    repoOwner,
    repoName,
    selectedRepo,
    setAutoAcceptEnabled,
  ]);

  const handleClose = useCallback(() => setModalOpen(false), [setModalOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const filtered = activeTab ? tickets.filter((t) => t.status === activeTab) : tickets;

  return (
    <div className="workflow-panel">
      <div className="workflow-panel-header">
        <h2 className="workflow-panel-title">Workflow</h2>
        <span className="workflow-panel-count">{tickets.length} ticket{tickets.length !== 1 ? 's' : ''}</span>
        <button
          type="button"
          className={`workflow-panel-auto-accept ${autoAcceptEnabled ? 'active' : ''}`}
          onClick={toggleAutoAccept}
          aria-pressed={autoAcceptEnabled}
          title={autoAcceptEnabled ? 'Turn off auto-accept' : 'Automatically accept and merge tickets in review'}
        >
          {autoAcceptEnabled ? 'Auto-accept on' : 'Auto-accept'}
        </button>
        <button className="workflow-panel-close" onClick={handleClose} title="Close">
          {'\u2715'}
        </button>
      </div>

      <div className="workflow-panel-tabs">
        {TABS.map((tab) => {
          const count = tab.key ? tickets.filter((t) => t.status === tab.key).length : tickets.length;
          return (
            <button
              key={tab.key || 'all'}
              className={`workflow-panel-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              <span className="workflow-panel-tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="workflow-panel-body">
        {isLoading && tickets.length === 0 && (
          <div className="workflow-panel-empty">Loading tickets...</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="workflow-panel-empty">
            {activeTab ? `No ${TABS.find((t) => t.key === activeTab)?.label.toLowerCase()} tickets.` : 'No workflow tickets yet.'}
          </div>
        )}
        {filtered.map((ticket) => (
          <WorkflowTicketRow key={ticket.id} ticket={ticket} />
        ))}
      </div>
    </div>
  );
}
