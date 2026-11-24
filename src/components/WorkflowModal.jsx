import { useState, useEffect, useCallback } from 'react';
import useWorkflowStore from '../stores/workflowStore';
import useSpaceManagerStore from '../stores/spaceManagerStore';
import usePlanStore from '../stores/planStore';
import { getTickets, subscribeToTickets } from '../services/workflowService';
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

  const [activeTab, setActiveTab] = useState(null);

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
