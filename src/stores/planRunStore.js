import { create } from 'zustand';

const usePlanRunStore = create((set) => ({
  status: 'idle',
  error: null,
  mergeError: null,
  currentTaskId: null,
  currentTicketId: null,
  lastFailedTaskId: null,
  spaceId: null,

  start: (spaceId) => set({
    status: 'running',
    error: null,
    mergeError: null,
    currentTaskId: null,
    currentTicketId: null,
    spaceId,
  }),

  setStatus: (status) => set({ status, mergeError: null }),
  setError: (error) => set({ error, status: error ? 'error' : 'idle', mergeError: null }),
  setCurrentTask: (taskId, ticketId = null) => set({
    currentTaskId: taskId,
    currentTicketId: ticketId,
  }),
  setLastFailedTaskId: (taskId) => set({ lastFailedTaskId: taskId }),
  setWaitingForReview: (taskId, ticketId) => set({
    status: 'waiting_for_review',
    mergeError: null,
    currentTaskId: taskId,
    currentTicketId: ticketId,
  }),
  setWaitingForPush: (taskId, ticketId, mergeError = null) => set({
    status: 'waiting_for_push',
    mergeError: mergeError || null,
    currentTaskId: taskId,
    currentTicketId: ticketId,
  }),
  reset: () => set({
    status: 'idle',
    error: null,
    mergeError: null,
    currentTaskId: null,
    currentTicketId: null,
    spaceId: null,
  }),
  clearError: () => set({ error: null }),
}));

export default usePlanRunStore;
