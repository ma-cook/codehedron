import { useCallback, useEffect } from 'react';
import usePlanStore from '../stores/planStore';
import usePlanRunStore from '../stores/planRunStore';
import { startPlanRun, stopPlanRun } from '../services/planRunService';
import PlanTaskRow from './PlanTaskRow';
import './PlanModal.css';

const RUN_LABELS = {
  running: 'Working...',
  waiting_for_review: 'Waiting for ticket review',
  waiting_for_push: 'Accepted - waiting for PR merge',
  stopping: 'Stopping...',
};

export default function PlanModal({ onEnsureWorkers }) {
  const isOpen = usePlanStore((s) => s.isPanelOpen);
  const setPanelOpen = usePlanStore((s) => s.setPanelOpen);
  const plan = usePlanStore((s) => s.plan);
  const tasks = usePlanStore((s) => s.tasks);
  const currentView = usePlanStore((s) => s.currentView);
  const setCurrentView = usePlanStore((s) => s.setCurrentView);
  const isLoading = usePlanStore((s) => s.isLoading);
  const runStatus = usePlanRunStore((s) => s.status);
  const runError = usePlanRunStore((s) => s.error);
  const mergeError = usePlanRunStore((s) => s.mergeError);

  const handleClose = useCallback(() => setPanelOpen(false), [setPanelOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  const handlePlay = useCallback(() => {
    if (!plan) return;
    startPlanRun({
      spaceId: plan.spaceId,
      ensureWorkers: onEnsureWorkers,
    });
  }, [plan, onEnsureWorkers]);

  const handleStop = useCallback(() => {
    stopPlanRun();
  }, []);

  const filteredTasks = tasks.filter((t) => {
    if (currentView === 'active') {
      return t.status === 'working_on' || t.status === 'to_review';
    }
    return t.status === currentView;
  });
  const todoCount = tasks.filter((t) => t.status === 'todo').length;
  const activeCount = tasks.filter(
    (t) => t.status === 'working_on' || t.status === 'to_review'
  ).length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const runActive = ['running', 'waiting_for_review', 'waiting_for_push', 'stopping'].includes(runStatus);
  const canPlay = !!plan && !runActive;

  if (!isOpen) return null;

  return (
    <div className="plan-panel">
      <div className="plan-panel-header">
        <h2 className="plan-panel-title">Plan</h2>
        <span className="plan-panel-count">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
        </span>
        <div className="plan-panel-run-actions">
          {runActive ? (
            <button
              className="plan-panel-run-button plan-panel-stop"
              onClick={handleStop}
              disabled={runStatus === 'stopping'}
              title="Stop plan run"
            >
              {runStatus === 'stopping' ? 'Stopping...' : 'Stop'}
            </button>
          ) : (
            <button
              className="plan-panel-run-button plan-panel-play"
              onClick={handlePlay}
              disabled={!canPlay}
              title="Run the next plan task"
            >
              Play
            </button>
          )}
        </div>
        <button className="plan-panel-close" onClick={handleClose} title="Close">
          {'\u2715'}
        </button>
      </div>

      {plan && (
        <div className="plan-panel-plan-title">{plan.title}</div>
      )}

      {(runActive || runError) && (
        <div className={`plan-panel-run-status ${runError ? 'error' : ''}`}>
          {runError || RUN_LABELS[runStatus] || runStatus}
          {!runError && mergeError && (
            <span className="plan-panel-merge-error">{mergeError}</span>
          )}
        </div>
      )}

      <div className="plan-panel-tabs">
        <button
          className={`plan-panel-tab ${currentView === 'todo' ? 'active' : ''}`}
          onClick={() => setCurrentView('todo')}
        >
          To Do
          <span className="plan-panel-tab-count">{todoCount}</span>
        </button>
        <button
          className={`plan-panel-tab ${currentView === 'active' ? 'active' : ''}`}
          onClick={() => setCurrentView('active')}
        >
          Active
          <span className="plan-panel-tab-count">{activeCount}</span>
        </button>
        <button
          className={`plan-panel-tab ${currentView === 'completed' ? 'active' : ''}`}
          onClick={() => setCurrentView('completed')}
        >
          Completed
          <span className="plan-panel-tab-count">{completedCount}</span>
        </button>
      </div>

      <div className="plan-panel-body">
        {isLoading && (
          <div className="plan-panel-empty">Loading plan...</div>
        )}
        {!isLoading && !plan && (
          <div className="plan-panel-empty">
            No active plan. The LLM will create one when you send a multi-step request.
          </div>
        )}
        {!isLoading && plan && filteredTasks.length === 0 && (
          <div className="plan-panel-empty">
            {currentView === 'todo' && 'All tasks completed!'}
            {currentView === 'active' && 'No task is running or waiting for review.'}
            {currentView === 'completed' && 'No completed tasks yet.'}
          </div>
        )}
        {filteredTasks.map((task) => (
          <PlanTaskRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
