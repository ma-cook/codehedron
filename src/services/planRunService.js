import useAuthStore from '../stores/authStore';
import useCodeStore from '../stores/codeStore';
import usePlanStore from '../stores/planStore';
import usePlanRunStore from '../stores/planRunStore';
import useWorkflowStore from '../stores/workflowStore';
import {
  claimNextTaskApi,
  finishTaskApi,
  heartbeatTaskApi,
  releaseTaskApi,
  removeTaskApi,
  emitPlanTaskUpdated,
} from './planApiService';
import {
  createTicket,
  updateTicket,
  getTickets,
  rejectTicket,
  emitTicketCreated,
  emitTicketUpdated,
} from './workflowService';
import {
  dispatchPlanTask,
  waitForConfiguredPlanWorker,
  stopPlanWorkers,
} from './planWorkerRegistry';
import {
  createPlanPullRequest,
  approveAndMergePlanPullRequest,
  syncPlanPullRequest,
  syncPlanRepoHead,
  closePlanPullRequest,
  refreshRepoContextAfterMerge,
  getDefaultBranch,
} from './planPullRequestService';
import { getBranchRef } from './githubIssuesService';
import { isGithubAuthenticated } from './githubRepoService';
import { buildOrchestratedPlanRunPrompt } from './planExecution';
import { hasSearchReplaceMarkers } from './githubPushService';

const REVIEW_POLL_MS = 15_000;
const HEARTBEAT_MS = 20_000;

let activeRun = null;

function getRepoCoordinates() {
  const state = useCodeStore.getState();
  const owner = state.selectedRepo?.owner?.login || state.selectedRepo?.owner || state.repoOwner;
  const repo = state.selectedRepo?.name || state.repoName;
  return { owner, repo, state };
}

function applyPlanTask(row) {
  if (!row?.id) return;
  usePlanStore.getState()._applyTaskUpdate(row);
  emitPlanTaskUpdated(row, row.plan_id, row.space_id);
}

function applyWorkflowTicket(ticket) {
  if (!ticket?.id) return;
  useWorkflowStore.getState().updateTicket(ticket);
  emitTicketUpdated(ticket);
}

function sleep(handle, ms) {
  return new Promise((resolve) => {
    if (handle.cancelled) {
      resolve();
      return;
    }
    const id = setTimeout(() => {
      handle.timers.delete(id);
      resolve();
    }, ms);
    handle.timers.set(id, resolve);
  });
}

function clearTimers(handle) {
  for (const [id, resolve] of handle.timers) {
    clearTimeout(id);
    resolve();
  }
  handle.timers.clear();
}

async function syncLatestHead(handle, coordinates, defaultBranch) {
  const { owner, repo } = coordinates;
  if (!handle.baseContextLoaded) {
    const ref = await getBranchRef(undefined, owner, repo, defaultBranch);
    if (ref.ok) {
      await refreshRepoContextAfterMerge({
        spaceId: handle.spaceId,
        owner,
        repo,
        defaultBranch,
        mergeCommitSha: ref.data?.object?.sha || null,
      });
      handle.baseContextLoaded = true;
      handle.baseCommitSha = ref.data?.object?.sha || null;
    }
    return;
  }

  const sha = await syncPlanRepoHead({
    spaceId: handle.spaceId,
    owner,
    repo,
    branch: defaultBranch,
  });
  if (sha) handle.baseCommitSha = sha;
}

async function fetchTickets(spaceId) {
  try {
    const tickets = await getTickets(spaceId);
    useWorkflowStore.getState().setTickets(tickets);
    return tickets;
  } catch (err) {
    console.warn('[PlanRun] Failed to refresh workflow tickets:', err.message);
    return useWorkflowStore.getState().tickets;
  }
}

async function rejectPlanTicket(ticket, reason) {
  if (!ticket?.id) return null;
  try {
    const rejected = await rejectTicket(ticket.id, reason);
    useWorkflowStore.getState().updateTicket(rejected);
    emitTicketUpdated(rejected);
    if (rejected.planTask) applyPlanTask(rejected.planTask);
    return rejected;
  } catch (err) {
    console.warn('[PlanRun] Failed to reject ticket:', err.message);
    return null;
  }
}

async function clearStaleAttemptTickets(handle, coordinates, task) {
  const tickets = await fetchTickets(handle.spaceId);
  const stale = tickets.filter(
    (item) => item.planTaskId === task.id && item.status !== 'merged'
  );

  for (const ticket of stale) {
    if (coordinates.owner && coordinates.repo) {
      await closePlanPullRequest({
        owner: coordinates.owner,
        repo: coordinates.repo,
        ticket,
      });
    }
    if (ticket.status === 'rejected') continue;
    try {
      const updated = await updateTicket(ticket.id, { status: 'rejected' });
      useWorkflowStore.getState().updateTicket(updated);
      emitTicketUpdated(updated);
    } catch (err) {
      console.warn('[PlanRun] Failed to clear a stale ticket:', err.message);
    }
  }
}

async function waitForReviewResolution(handle, coordinates, task, ticketId, defaultBranch) {
  const { owner, repo } = coordinates;
  let mergeError = null;

  while (!handle.cancelled) {
    const tickets = await fetchTickets(handle.spaceId);
    let ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket) {
      throw new Error('The workflow ticket for this plan task no longer exists');
    }

    if (ticket.status === 'rejected') {
      usePlanRunStore.getState().setLastFailedTaskId(task.id);
      await usePlanStore.getState().refreshPlan();
      const failedTask = usePlanStore.getState().tasks.find((item) => item.id === task.id);
      throw new Error(failedTask?.lastError || 'The plan task was rejected');
    }

    if (ticket.status === 'to_review' && ticket.githubPrNumber) {
      const sync = await syncPlanPullRequest({ owner, repo, ticket });
      if (sync.ok && sync.state === 'merged') {
        applyWorkflowTicket(sync.ticket);
        if (sync.ticket.planTask) applyPlanTask(sync.ticket.planTask);
        await refreshRepoContextAfterMerge({
          spaceId: handle.spaceId,
          owner,
          repo,
          defaultBranch,
          mergeCommitSha: sync.ticket.githubMergeCommitSha || sync.pr?.merge_commit_sha,
        });
        handle.baseContextLoaded = true;
        return 'merged';
      }
      if (sync.ok && sync.state === 'closed') {
        if (sync.ticket.planTask) applyPlanTask(sync.ticket.planTask);
        usePlanRunStore.getState().setLastFailedTaskId(task.id);
        throw new Error('The pull request was closed without merging');
      }
    }

    if (ticket.status === 'merged') {
      let mergeSha = ticket.githubMergeCommitSha;
      if (ticket.githubPrNumber) {
        const merged = await syncPlanPullRequest({ owner, repo, ticket });
        if (merged.ok && merged.state === 'merged') {
          applyWorkflowTicket(merged.ticket);
          if (merged.ticket.planTask) applyPlanTask(merged.ticket.planTask);
          mergeSha = merged.ticket.githubMergeCommitSha || merged.pr?.merge_commit_sha || mergeSha;
        }
      }
      if (!mergeSha) {
        mergeSha = await syncPlanRepoHead({
          spaceId: handle.spaceId,
          owner,
          repo,
          branch: defaultBranch,
        });
      }
      await refreshRepoContextAfterMerge({
        spaceId: handle.spaceId,
        owner,
        repo,
        defaultBranch,
        mergeCommitSha: mergeSha,
      });
      await usePlanStore.getState().refreshPlan();
      handle.baseContextLoaded = true;
      return 'merged';
    }

    if (ticket.status === 'committed') {
      usePlanRunStore.getState().setStatus('running');
      const merged = await approveAndMergePlanPullRequest({ owner, repo, ticket });
      if (merged.ok) {
        applyWorkflowTicket(merged.ticket);
        if (merged.ticket.planTask) applyPlanTask(merged.ticket.planTask);
        await refreshRepoContextAfterMerge({
          spaceId: handle.spaceId,
          owner,
          repo,
          defaultBranch,
          mergeCommitSha: merged.ticket.githubMergeCommitSha,
        });
        handle.baseContextLoaded = true;
        return 'merged';
      }

      mergeError = merged.error;
      usePlanRunStore.getState().setWaitingForPush(task.id, ticket.id, mergeError);
      const sync = await syncPlanPullRequest({ owner, repo, ticket });
      if (sync.ok && sync.state === 'merged') {
        applyWorkflowTicket(sync.ticket);
        if (sync.ticket.planTask) applyPlanTask(sync.ticket.planTask);
        await refreshRepoContextAfterMerge({
          spaceId: handle.spaceId,
          owner,
          repo,
          defaultBranch,
          mergeCommitSha: sync.ticket.githubMergeCommitSha || sync.pr?.merge_commit_sha,
        });
        handle.baseContextLoaded = true;
        return 'merged';
      }
      if (sync.ok && sync.state === 'closed') {
        if (sync.ticket.planTask) applyPlanTask(sync.ticket.planTask);
        usePlanRunStore.getState().setLastFailedTaskId(task.id);
        throw new Error('The pull request was closed without merging');
      }
    } else {
      usePlanRunStore.getState().setWaitingForReview(task.id, ticket.id);
    }

    await sleep(handle, REVIEW_POLL_MS);
  }

  if (mergeError && !handle.cancelled) {
    throw new Error(mergeError);
  }
  return 'stopped';
}

async function releaseClaim(handle, reason) {
  const claim = handle.activeClaim;
  if (!claim) return;
  handle.activeClaim = null;
  try {
    const released = await releaseTaskApi(handle.planId, claim.taskId, {
      claimToken: claim.claimToken,
      error: reason,
    });
    if (released?.task) applyPlanTask(released.task);
  } catch (err) {
    // A 409 means the claim expired during a long round - nothing left to
    // release, so this is expected fallout of a slow turn, not an error.
    if (/409|no longer active/i.test(err?.message || '')) {
      console.log('[PlanRun] Task claim already expired - nothing to release');
    } else {
      console.warn('[PlanRun] Failed to release task claim:', err.message);
    }
  }
}

async function executeTask(handle, coordinates, task) {
  const { owner, repo } = coordinates;
  const plan = usePlanStore.getState().plan;
  const auth = useAuthStore.getState().authState;
  const user = auth.user;
  const prompt = buildOrchestratedPlanRunPrompt(plan, task);

  usePlanRunStore.getState().setStatus('running');
  usePlanRunStore.getState().setCurrentTask(task.id);

  let ticket = null;
  try {
    await clearStaleAttemptTickets(handle, coordinates, task);
    ticket = await createTicket({
      spaceId: handle.spaceId,
      userId: user?.uid || user?.sub,
      userName: user?.name || user?.email || 'Anonymous',
      userPicture: user?.picture || null,
      promptPreview: task.text.slice(0, 120),
      promptFull: prompt,
      planTaskId: task.id,
    });
    emitTicketCreated(ticket);
    usePlanRunStore.getState().setCurrentTask(task.id, ticket.id);

    const worker = await waitForConfiguredPlanWorker(handle.spaceId);
    if (!worker) {
      throw new Error('No idle configured Code chat is available for this plan run');
    }

    await syncLatestHead(handle, coordinates, handle.defaultBranch);

    const heartbeat = setInterval(() => {
      heartbeatTaskApi(plan.id, task.id, handle.activeClaim?.claimToken).catch(() => {});
    }, HEARTBEAT_MS);

    let result;
    try {
      result = await dispatchPlanTask(worker, {
        task,
        prompt,
        ticket,
        spaceId: handle.spaceId,
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (handle.cancelled || result?.aborted) {
      await rejectPlanTicket(result?.ticket || ticket, 'Plan run stopped');
      await releaseClaim(handle, 'Plan run stopped');
      return 'stopped';
    }

    if (!result?.ok) {
      throw new Error(result?.error || 'The LLM did not complete the task');
    }

    const newChanges = (result.newChanges || []).filter(
      (change) => change.filePath && typeof change.proposed === 'string'
    );
    if (newChanges.length === 0 || !result.hasCode) {
      throw new Error('The LLM did not generate any file changes');
    }

    const unapplied = newChanges.find(
      (change) => change.isWholeFileProposal || hasSearchReplaceMarkers(change.proposed)
    );
    if (unapplied) {
      throw new Error(`Generated changes for ${unapplied.filePath} did not apply cleanly`);
    }

    const files = newChanges.map((change) => ({
      path: change.filePath,
      content: change.proposed,
    }));
    const diffs = newChanges.map((change) => ({
      filePath: change.filePath,
      original: change.original,
      proposed: change.proposed,
      action: change.action,
    }));

    const ticketForPr = result.ticket || ticket;
    const pr = await createPlanPullRequest({
      owner,
      repo,
      task,
      ticket: ticketForPr,
      files,
      diffs,
      defaultBranch: handle.defaultBranch,
    });
    if (!pr.ok) {
      throw new Error(pr.error || 'Failed to create the plan pull request');
    }
    applyWorkflowTicket(pr.ticket);
    ticket = pr.ticket;

    const finished = await finishTaskApi(plan.id, task.id, {
      claimToken: handle.activeClaim?.claimToken,
      ticketId: ticket.id,
    });
    handle.activeClaim = null;
    if (finished?.task) applyPlanTask(finished.task);

    if (handle.cancelled) {
      usePlanRunStore.getState().setStatus('idle');
      return 'stopped';
    }

    return await waitForReviewResolution(
      handle,
      coordinates,
      task,
      ticket.id,
      handle.defaultBranch
    );
  } catch (err) {
    if (ticket?.githubPrNumber && ticket.status !== 'merged') {
      await closePlanPullRequest({ owner, repo, ticket });
    }
    await rejectPlanTicket(ticket, err.message);
    await releaseClaim(handle, err.message);
    throw err;
  }
}

async function runPlan(handle) {
  const runStore = usePlanRunStore.getState();
  const auth = useAuthStore.getState().authState;
  if (!auth.isAuthenticated || auth.user?.isGuest) {
    throw new Error('Sign in to run a plan');
  }
  if (!isGithubAuthenticated()) {
    throw new Error('Connect GitHub before running a plan');
  }

  const coordinates = getRepoCoordinates();
  if (!coordinates.owner || !coordinates.repo) {
    throw new Error('Select a GitHub repository before running a plan');
  }
  if (!coordinates.state.selectedBranch) {
    throw new Error('Select the repository default branch before running a plan');
  }
  if ((coordinates.state.pendingChanges || []).length > 0) {
    throw new Error('Resolve pending code changes before running a plan');
  }

  const defaultBranch = await getDefaultBranch(coordinates.owner, coordinates.repo);
  if (coordinates.state.selectedBranch !== defaultBranch) {
    throw new Error(`Switch to the default branch (${defaultBranch}) before running a plan`);
  }
  handle.defaultBranch = defaultBranch;

  await usePlanStore.getState().refreshPlan();
  const planState = usePlanStore.getState();
  if (!planState.plan || planState.plan.spaceId !== handle.spaceId) {
    throw new Error('No active plan in this space');
  }
  const hasRunnable = planState.tasks.some(
    (task) => task.status === 'todo' || task.status === 'to_review' || task.status === 'working_on'
  );
  if (!hasRunnable) {
    throw new Error('All plan tasks are complete. Add another task to keep working.');
  }

  const worker = await waitForConfiguredPlanWorker(handle.spaceId);
  if (!worker) {
    throw new Error('No idle configured Code chat is available. Open one or let the current chat finish, then try again.');
  }

  runStore.start(handle.spaceId);
  handle.planId = planState.plan.id;

  while (!handle.cancelled) {
    const currentPlan = usePlanStore.getState();
    if (!currentPlan.plan || currentPlan.plan.id !== handle.planId) {
      throw new Error('The active plan changed while the run was in progress');
    }

    const reviewTask = currentPlan.tasks.find((task) => task.status === 'to_review');
    if (reviewTask?.ticketId) {
      const outcome = await waitForReviewResolution(
        handle,
        coordinates,
        reviewTask,
        reviewTask.ticketId,
        defaultBranch
      );
      if (outcome === 'merged') {
        usePlanRunStore.getState().setLastFailedTaskId(null);
        continue;
      }
      break;
    }

    const claim = await claimNextTaskApi(currentPlan.plan.id, {
      retryTaskId: handle.retryTaskId,
    });
    if (!claim?.task) {
      usePlanRunStore.getState().setStatus('idle');
      break;
    }
    handle.retryTaskId = null;
    handle.activeClaim = {
      taskId: claim.task.id,
      claimToken: claim.claimToken,
    };
    applyPlanTask(claim.task);

    const task = usePlanStore.getState().tasks.find((item) => item.id === claim.task.id)
      || claim.task;
    const outcome = await executeTask(handle, coordinates, task);
    handle.activeClaim = null;
    if (outcome === 'merged') {
      usePlanRunStore.getState().setLastFailedTaskId(null);
      continue;
    }
    break;
  }
}

export async function startPlanRun({ spaceId, ensureWorkers }) {
  if (activeRun) return false;

  const runStore = usePlanRunStore.getState();
  const handle = {
    spaceId,
    planId: null,
    defaultBranch: null,
    retryTaskId: runStore.lastFailedTaskId,
    activeClaim: null,
    baseContextLoaded: false,
    cancelled: false,
    timers: new Map(),
  };

  runStore.clearError();
  runStore.setStatus('running');
  runStore.setLastFailedTaskId(runStore.lastFailedTaskId);

  const promise = (async () => {
    try {
      await ensureWorkers?.();
      await runPlan(handle);
      if (!handle.cancelled) usePlanRunStore.getState().setStatus('idle');
    } catch (err) {
      if (handle.cancelled) {
        usePlanRunStore.getState().setStatus('idle');
      } else {
        usePlanRunStore.getState().setError(err.message || 'Plan run failed');
      }
    } finally {
      clearTimers(handle);
      handle.activeClaim = null;
      activeRun = null;
    }
  })();

  activeRun = { handle, promise };
  return true;
}

export async function stopPlanRun() {
  if (!activeRun) return;
  const { handle, promise } = activeRun;
  handle.cancelled = true;
  usePlanRunStore.getState().setStatus('stopping');
  stopPlanWorkers(handle.spaceId);
  clearTimers(handle);
  await releaseClaim(handle, 'Plan run stopped');
  await promise;
  usePlanRunStore.getState().setStatus('idle');
}

export function isPlanRunActive() {
  return !!activeRun;
}

export async function deletePlanTask(task) {
  if (!task || !task.id) return false;
  const run = usePlanRunStore.getState();
  const plan = usePlanStore.getState().plan;

  const isActiveTask = task.status === 'working_on' || task.status === 'to_review';
  if (
    activeRun
    && isActiveTask
    && run.spaceId === task.spaceId
    && (run.currentTaskId === task.id || task.status === 'working_on')
  ) {
    await stopPlanRun();
  }

  const coordinates = getRepoCoordinates();
  const tickets = await fetchTickets(task.spaceId);
  const linkedTickets = tickets.filter(
    (item) => item.id === task.ticketId || item.planTaskId === task.id
  );

  for (const ticket of linkedTickets) {
    if (ticket.status === 'merged' || ticket.status === 'rejected') continue;
    if (coordinates.owner && coordinates.repo) {
      await closePlanPullRequest({ owner: coordinates.owner, repo: coordinates.repo, ticket });
    }
    await rejectPlanTicket(ticket, 'Plan task deleted');
  }

  if (plan) {
    await removeTaskApi(plan.id, task.id);
    usePlanStore.setState((state) => ({
      tasks: state.tasks.filter((item) => item.id !== task.id),
    }));
  }

  return true;
}
