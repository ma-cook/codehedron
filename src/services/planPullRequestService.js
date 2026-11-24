import useCodeStore from '../stores/codeStore';
import { safeSetItem } from '../utils/safeLocalStorage';
import { fetchRepoContext, populateContentStoreWorker } from './zenService';
import { isGithubAuthenticated } from './githubRepoService';
import {
  getRepoInfo,
  getBranchRef,
  createBranchRef,
  deleteBranchRef,
  multiFileCommit,
  createPullRequest,
  approvePullRequest,
  mergePullRequest,
  getPullRequest,
  closePullRequest,
} from './githubIssuesService';
import {
  updateTicket,
  acceptTicket,
  rejectTicket,
  markTicketMerged,
  emitTicketUpdated,
} from './workflowService';

const TOKEN = undefined;

function prBranchName(task) {
  const shortId = String(task?.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  return `hoverchart/plan-${shortId || Date.now()}`;
}

function describeError(result, fallback) {
  return result?.error || fallback;
}

function ticketMatchesRepo(ticket, owner, repo) {
  if (!ticket?.githubPrUrl || !owner || !repo) return true;
  const path = `/${owner}/${repo}/pull/${ticket.githubPrNumber}`.toLowerCase();
  return ticket.githubPrUrl.toLowerCase().includes(path);
}

export async function getDefaultBranch(owner, repo) {
  const result = await getRepoInfo(TOKEN, owner, repo);
  if (!result.ok) throw new Error(describeError(result, 'Failed to read repository'));
  return result.data.default_branch;
}

export async function createPlanPullRequest({
  owner,
  repo,
  task,
  ticket,
  files,
  diffs,
  defaultBranch,
}) {
  if (!isGithubAuthenticated()) {
    return { ok: false, error: 'GitHub is not connected' };
  }
  if (!owner || !repo) {
    return { ok: false, error: 'Select a GitHub repository first' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: 'No generated files to commit' };
  }

  const branch = prBranchName(task);
  const baseRef = await getBranchRef(TOKEN, owner, repo, defaultBranch);
  if (!baseRef.ok) {
    return { ok: false, error: describeError(baseRef, 'Failed to read the default branch') };
  }

  let branchResult = await createBranchRef(TOKEN, owner, repo, branch, baseRef.data.object.sha);
  if (!branchResult.ok) {
    await deleteBranchRef(TOKEN, owner, repo, branch);
    branchResult = await createBranchRef(TOKEN, owner, repo, branch, baseRef.data.object.sha);
  }
  if (!branchResult.ok) {
    return { ok: false, error: describeError(branchResult, 'Failed to create the task branch') };
  }

  const commit = await multiFileCommit(
    TOKEN,
    owner,
    repo,
    branch,
    files,
    `plan(${task.id.slice(0, 8)}): ${task.text.slice(0, 72)}`
  );
  if (!commit.ok) {
    await deleteBranchRef(TOKEN, owner, repo, branch);
    return { ok: false, error: describeError(commit, 'Failed to commit generated files') };
  }

  const prResult = await createPullRequest(TOKEN, owner, repo, {
    title: `Plan task: ${task.text.slice(0, 90)}`,
    body: `Automated plan task from hoverchart.\n\n**Task**\n${task.text}\n\n**Files**\n${files.map((file) => `- ${file.path}`).join('\n')}`,
    head: branch,
    base: defaultBranch,
  });
  if (!prResult.ok) {
    await deleteBranchRef(TOKEN, owner, repo, branch);
    return { ok: false, error: describeError(prResult, 'Failed to open a pull request') };
  }

  try {
    const updated = await updateTicket(ticket.id, {
      status: 'to_review',
      filesTouched: files.map((file) => file.path),
      diffs: diffs || [],
      githubBranch: branch,
      githubBaseBranch: defaultBranch,
      githubPrNumber: prResult.data.number,
      githubPrUrl: prResult.data.html_url,
      githubPrState: prResult.data.state || 'open',
    });
    emitTicketUpdated(updated);
    return { ok: true, ticket: updated, pr: prResult.data, branch };
  } catch (err) {
    await closePullRequest(TOKEN, owner, repo, prResult.data.number).catch(() => {});
    await deleteBranchRef(TOKEN, owner, repo, branch);
    return { ok: false, error: `Pull request created but ticket update failed: ${err.message}` };
  }
}

export async function approveAndMergePlanPullRequest({ owner, repo, ticket }) {
  if (!ticket?.githubPrNumber) {
    return { ok: false, error: 'Ticket has no pull request', permanent: true };
  }
  if (!ticketMatchesRepo(ticket, owner, repo)) {
    return {
      ok: false,
      error: `This pull request belongs to a different repository. Switch to the ticket's repository before merging.`,
      permanent: true,
    };
  }

  await approvePullRequest(TOKEN, owner, repo, ticket.githubPrNumber).catch(() => {});

  const merge = await mergePullRequest(TOKEN, owner, repo, ticket.githubPrNumber);
  if (!merge.ok) {
    return {
      ok: false,
      error: describeError(merge, 'Merge is blocked'),
      permanent: merge.status === 405 || merge.status === 409,
    };
  }

  const updated = await markTicketMerged(
    ticket.id,
    merge.data?.sha || merge.data?.merge_commit_sha || null
  );
  emitTicketUpdated(updated);
  return { ok: true, ticket: updated };
}

export async function syncPlanPullRequest({ owner, repo, ticket }) {
  if (!ticket?.githubPrNumber) {
    return { ok: false, error: 'Ticket has no pull request' };
  }
  if (!ticketMatchesRepo(ticket, owner, repo)) {
    return { ok: false, error: 'Ticket belongs to a different repository' };
  }

  const result = await getPullRequest(TOKEN, owner, repo, ticket.githubPrNumber);
  if (!result.ok) {
    return { ok: false, error: describeError(result, 'Failed to read pull request') };
  }

  if (result.data.merged) {
    if (ticket.status !== 'committed' && ticket.status !== 'merged') {
      await acceptTicket(ticket.id).catch(() => {});
    }
    const updated = await markTicketMerged(
      ticket.id,
      result.data.merge_commit_sha || null
    );
    emitTicketUpdated(updated);
    return { ok: true, state: 'merged', ticket: updated, pr: result.data };
  }

  if (result.data.state === 'closed') {
    const updated = await rejectTicket(ticket.id, 'Pull request was closed without merging');
    emitTicketUpdated(updated);
    return { ok: true, state: 'closed', ticket: updated, pr: result.data };
  }

  return { ok: true, state: 'open', ticket, pr: result.data };
}

export async function closePlanPullRequest({ owner, repo, ticket }) {
  if (!ticket?.githubPrNumber || !owner || !repo) return;
  if (!ticketMatchesRepo(ticket, owner, repo)) return;

  if (ticket.githubPrState !== 'merged' && ticket.status !== 'merged') {
    await closePullRequest(TOKEN, owner, repo, ticket.githubPrNumber).catch(() => {});
  }
  if (ticket.githubBranch) {
    await deleteBranchRef(TOKEN, owner, repo, ticket.githubBranch).catch(() => {});
  }
}

export async function syncPlanRepoHead({ spaceId, owner, repo, branch }) {
  const ref = await getBranchRef(TOKEN, owner, repo, branch);
  if (!ref.ok) return null;
  const sha = ref.data?.object?.sha || null;
  if (sha) {
    try {
      safeSetItem(`diagramCommitSha_${spaceId}`, sha);
    } catch { /* ignore */ }
  }
  return sha;
}

function isSelectedRepo(spaceId, owner, repo) {
  const state = useCodeStore.getState();
  if (!state._spaceId || state._spaceId !== spaceId) return false;
  const selected = state.selectedRepo;
  if (!selected) return false;
  const ownerLogin = typeof selected.owner === 'string' ? selected.owner : selected.owner?.login;
  const fullName = selected.full_name || (ownerLogin && selected.name ? `${ownerLogin}/${selected.name}` : '');
  return fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase();
}

export async function refreshRepoContextAfterMerge({
  spaceId,
  owner,
  repo,
  defaultBranch,
  mergeCommitSha,
}) {
  if (!isSelectedRepo(spaceId, owner, repo)) return;

  try {
    safeSetItem(`diagramCommitSha_${spaceId}`, mergeCommitSha || '');
  } catch { /* ignore */ }

  try {
    const context = await fetchRepoContext(undefined, owner, repo, defaultBranch);
    if (!context?.fileTree) return;
    if (!isSelectedRepo(spaceId, owner, repo)) return;
    useCodeStore.getState().setRepoContext(context.fileTree, context.fileContents);
    if (Object.keys(context.fileContents || {}).length > 0) {
      populateContentStoreWorker(context.fileContents, null).catch(() => {});
    }
  } catch (err) {
    console.warn('[PlanPR] Failed to refresh repository context:', err.message);
  }
}
