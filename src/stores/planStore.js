import { create } from 'zustand';
import {
  getPlan,
  createPlanApi,
  addTaskApi,
  completeTaskApi,
  uncompleteTaskApi,
  removeTaskApi,
  subscribeToPlan,
  emitPlanTaskCreated,
  emitPlanTaskUpdated,
  emitPlanTaskDeleted,
} from '../services/planApiService';

/**
 * Plan overlay store — tracks LLM-created task plans for the current space.
 * Plans are persisted to the SQL backend and synced across users via socket.io.
 *
 * Plan shape:
 * {
 *   id: string,
 *   spaceId: string,
 *   title: string,
 *   tasks: Task[],
 *   createdAt: string,
 * }
 *
 * Task shape:
 * {
 *   id: string,
 *   planId: string,
 *   spaceId: string,
 *   userId: string,
 *   userName: string,
 *   userPicture: string | null,
 *   text: string,
 *   status: 'todo' | 'working_on' | 'to_review' | 'completed',
 *   sortOrder: number,
 *   dependsOn: string[],
 *   claimedBy: string | null,
 *   claimedAt: string | null,
 *   ticketId: string | null,
 *   lastError: string | null,
 *   createdAt: string,
 *   completedAt: string | null,
 * }
 */

const usePlanStore = create((set, get) => ({
  plan: null,
  tasks: [],
  isPanelOpen: false,
  currentView: 'todo',
  spaceId: null,
  isLoading: false,
  _unsub: null,

  initSpace: async (spaceId) => {
    const { _unsub } = get();
    if (_unsub) _unsub();

    if (!spaceId) {
      set({ plan: null, tasks: [], spaceId: null, isLoading: false, _unsub: null });
      return;
    }

    set({ spaceId, isLoading: true });

    try {
      const planData = await getPlan(spaceId);
      set({
        plan: planData ? { id: planData.id, spaceId: planData.space_id, title: planData.title, createdAt: planData.created_at } : null,
        tasks: (planData?.tasks || []).map(normalizeTask),
        isLoading: false,
      });
    } catch (err) {
      console.warn('[PlanStore] Failed to fetch plan:', err.message);
      set({ plan: null, tasks: [], isLoading: false });
    }

    // Subscribe to real-time updates
    const unsub = subscribeToPlan(spaceId, {
      onTaskCreated: (task) => {
        set((state) => ({
          tasks: [...state.tasks, normalizeTask(task)],
        }));
      },
      onTaskUpdated: (task) => {
        set((state) => ({
          tasks: state.tasks.map((t) => t.id === task.id ? normalizeTask(task) : t),
        }));
      },
      onTaskDeleted: (taskId) => {
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== taskId),
        }));
      },
      onSync: (data) => {
        if (data.plan) {
          set({
            plan: { id: data.plan.id, spaceId: data.plan.space_id, title: data.plan.title, createdAt: data.plan.created_at },
            tasks: (data.tasks || []).map(normalizeTask),
          });
        }
      },
    });

    set({ _unsub: unsub });
  },

  refreshPlan: async () => {
    const { spaceId } = get();
    if (!spaceId) return null;
    try {
      const planData = await getPlan(spaceId);
      if (!planData) {
        set({ plan: null, tasks: [] });
        return null;
      }
      set({
        plan: {
          id: planData.id,
          spaceId: planData.space_id,
          title: planData.title,
          createdAt: planData.created_at,
        },
        tasks: (planData.tasks || []).map(normalizeTask),
      });
      return planData;
    } catch (err) {
      console.warn('[PlanStore] Failed to refresh plan:', err.message);
      return null;
    }
  },

  createPlan: async (title) => {
    const { spaceId } = get();
    if (!spaceId) return null;
    try {
      const planData = await createPlanApi(spaceId, title);
      const plan = { id: planData.id, spaceId: planData.space_id, title: planData.title, createdAt: planData.created_at };
      set({ plan, tasks: [] });
      return plan;
    } catch (err) {
      console.warn('[PlanStore] Failed to create plan:', err.message);
      return null;
    }
  },

  addTask: async (text, userId, userName, userPicture) => {
    const { plan, spaceId } = get();
    if (!plan || !spaceId) return null;
    try {
      const taskData = await addTaskApi(plan.id, { text, userId, userName, userPicture });
      const task = normalizeTask(taskData);
      set((state) => ({ tasks: [...state.tasks, task] }));
      emitPlanTaskCreated(taskData, plan.id, spaceId);
      return task;
    } catch (err) {
      console.warn('[PlanStore] Failed to add task:', err.message);
      return null;
    }
  },

  completeTask: async (taskId) => {
    const { plan, spaceId } = get();
    if (!plan || !spaceId) return false;
    try {
      const taskData = await completeTaskApi(plan.id, taskId);
      const task = normalizeTask(taskData);
      set((state) => ({
        tasks: state.tasks.map((t) => t.id === taskId ? task : t),
      }));
      emitPlanTaskUpdated(taskData, plan.id, spaceId);
      return true;
    } catch (err) {
      console.warn('[PlanStore] Failed to complete task:', err.message);
      return false;
    }
  },

  uncompleteTask: async (taskId) => {
    const { plan, spaceId } = get();
    if (!plan || !spaceId) return false;
    try {
      const taskData = await uncompleteTaskApi(plan.id, taskId);
      const task = normalizeTask(taskData);
      set((state) => ({
        tasks: state.tasks.map((t) => t.id === taskId ? task : t),
      }));
      emitPlanTaskUpdated(taskData, plan.id, spaceId);
      return true;
    } catch (err) {
      console.warn('[PlanStore] Failed to uncomplete task:', err.message);
      return false;
    }
  },

  removeTask: async (taskId) => {
    const { plan, spaceId } = get();
    if (!plan || !spaceId) return;
    try {
      await removeTaskApi(plan.id, taskId);
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== taskId),
      }));
      emitPlanTaskDeleted(taskId, plan.id, spaceId);
    } catch (err) {
      console.warn('[PlanStore] Failed to remove task:', err.message);
    }
  },

  setPanelOpen: (open) => set({ isPanelOpen: open }),
  togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),

  setCurrentView: (view) => set({ currentView: view }),
  toggleView: () => set((state) => ({
    currentView: state.currentView === 'todo' ? 'completed' : 'todo',
  })),

  getTodoTasks: () => {
    return get().tasks.filter((t) => t.status === 'todo');
  },

  getCompletedTasks: () => {
    return get().tasks.filter((t) => t.status === 'completed');
  },

  getActiveTasks: () => {
    return get().tasks.filter((t) => t.status === 'working_on' || t.status === 'to_review');
  },

  getTaskCount: () => {
    const { tasks } = get();
    return {
      total: tasks.length,
      todo: tasks.filter((t) => t.status === 'todo').length,
      workingOn: tasks.filter((t) => t.status === 'working_on').length,
      toReview: tasks.filter((t) => t.status === 'to_review').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
    };
  },

  // Called by toolExecutor — synchronous local update for immediate UI feedback
  // The API call is made by the tool executor, this just updates the store
  _addTaskLocal: (task) => {
    set((state) => ({
      tasks: [...state.tasks, normalizeTask(task)],
    }));
  },

  _applyTaskUpdate: (row) => {
    if (!row?.id) return;
    const task = normalizeTask(row);
    set((state) => ({
      tasks: state.tasks.some((t) => t.id === task.id)
        ? state.tasks.map((t) => (t.id === task.id ? task : t))
        : [...state.tasks, task],
    }));
  },

  _setPlan: (planData) => {
    set({
      plan: planData ? { id: planData.id, spaceId: planData.space_id, title: planData.title, createdAt: planData.created_at } : null,
    });
  },
}));

function normalizeTask(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    spaceId: row.space_id,
    userId: row.user_id,
    userName: row.user_name,
    userPicture: row.user_picture,
    text: row.text,
    status: row.status,
    sortOrder: row.sort_order,
    dependsOn: row.depends_on || [],
    claimedBy: row.claimed_by || null,
    claimedAt: row.claimed_at || null,
    ticketId: row.ticket_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export default usePlanStore;
