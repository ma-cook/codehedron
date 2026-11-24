import { useCallback, useState } from 'react';
import usePlanStore from '../stores/planStore';
import usePlanRunStore from '../stores/planRunStore';
import { confirmDialog, notify } from '../stores/dialogStore';
import { deletePlanTask } from '../services/planRunService';

const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting_for_review', 'waiting_for_push']);

const STATUS_LABELS = {
  working_on: 'Working',
  to_review: 'Review',
};

export default function PlanTaskRow({ task }) {
  const [removing, setRemoving] = useState(false);
  const completeTask = usePlanStore((s) => s.completeTask);
  const uncompleteTask = usePlanStore((s) => s.uncompleteTask);
  const runStatus = usePlanRunStore((s) => s.status);
  const runSpaceId = usePlanRunStore((s) => s.spaceId);

  const isCompleted = task.status === 'completed';
  const isBusy = task.status === 'working_on' || task.status === 'to_review';
  const runActive = ACTIVE_RUN_STATUSES.has(runStatus) && runSpaceId === task.spaceId;

  const handleToggle = useCallback(() => {
    if (isBusy || runActive) return;
    if (task.status === 'todo') {
      completeTask(task.id);
    } else {
      uncompleteTask(task.id);
    }
  }, [task.id, task.status, isBusy, runActive, completeTask, uncompleteTask]);

  const handleRemove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: 'Delete plan task?',
      message: isBusy
        ? 'This stops the task, closes its pull request, and removes it from the plan.'
        : 'This removes the task from the plan. Any open pull request for it is closed.',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;

    setRemoving(true);
    try {
      await deletePlanTask(task);
    } catch (err) {
      notify(err.message || 'Failed to delete task', { type: 'error' });
    } finally {
      setRemoving(false);
    }
  }, [task, isBusy]);

  const initials = (task.userName || 'A').charAt(0).toUpperCase();

  return (
    <div className={`plan-task-row ${isBusy ? 'active' : ''}`}>
      <button
        className={`plan-task-checkbox ${isCompleted ? 'checked' : ''} ${isBusy ? 'busy' : ''}`}
        onClick={handleToggle}
        disabled={isBusy || runActive}
        title={isBusy ? 'This task is active' : runActive ? 'The plan is running' : isCompleted ? 'Mark as todo' : 'Mark completed'}
      >
        {isCompleted ? '\u2713' : isBusy ? '\u25CF' : ''}
      </button>
      <div className="plan-task-content">
        <span className={`plan-task-text ${isCompleted ? 'completed' : ''}`}>
          {task.text}
        </span>
        <div className="plan-task-attribution">
          {task.userPicture ? (
            <img src={task.userPicture} alt="" className="plan-task-avatar-img" />
          ) : (
            <span className="plan-task-avatar-fallback">{initials}</span>
          )}
          <span className="plan-task-user">{task.userName || 'Anonymous'}</span>
          {STATUS_LABELS[task.status] && (
            <span className={`plan-task-status ${task.status}`}>
              {STATUS_LABELS[task.status]}
            </span>
          )}
        </div>
        {task.lastError && (
          <div className="plan-task-error">{task.lastError}</div>
        )}
      </div>
      <button
        className="plan-task-delete"
        onClick={handleRemove}
        disabled={removing}
        title="Remove task"
      >
        {removing ? '...' : '\u2715'}
      </button>
    </div>
  );
}
