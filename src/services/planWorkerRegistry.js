const workers = new Map();
const busyWorkers = new Set();

const workerKey = (spaceId, windowId) => `${spaceId}:${windowId}`;

export function registerPlanWorker(worker) {
  if (!worker?.spaceId || worker.windowId == null) return;
  workers.set(workerKey(worker.spaceId, worker.windowId), worker);
}

export function unregisterPlanWorker(spaceId, windowId) {
  if (!spaceId || windowId == null) return;
  workers.delete(workerKey(spaceId, windowId));
  busyWorkers.delete(workerKey(spaceId, windowId));
}

export function getPlanWorkers(spaceId) {
  if (!spaceId) return [];
  return [...workers.values()].filter((worker) => worker.spaceId === spaceId);
}

export function isPlanWorkerBusy(spaceId, windowId) {
  return busyWorkers.has(workerKey(spaceId, windowId));
}

export function getAvailablePlanWorker(spaceId) {
  return getPlanWorkers(spaceId).find(
    (worker) =>
      worker.configured &&
      !worker.busy &&
      !isPlanWorkerBusy(spaceId, worker.windowId)
  ) || null;
}

export function hasConfiguredPlanWorker(spaceId) {
  return getPlanWorkers(spaceId).some((worker) => worker.configured);
}

export async function waitForConfiguredPlanWorker(
  spaceId,
  { timeoutMs = 8000, intervalMs = 150 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = getAvailablePlanWorker(spaceId);
    if (worker) return worker;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

export async function dispatchPlanTask(worker, payload) {
  if (!worker) throw new Error('No plan worker is available');
  const key = workerKey(worker.spaceId, worker.windowId);
  if (!worker.configured) throw new Error('The selected chat window is not configured');
  if (worker.busy || busyWorkers.has(key)) throw new Error('The selected chat window is busy');

  busyWorkers.add(key);
  try {
    return await worker.sendTask(payload);
  } finally {
    busyWorkers.delete(key);
  }
}

export function stopPlanWorker(worker) {
  if (!worker) return;
  worker.stop?.();
}

export function stopPlanWorkers(spaceId) {
  for (const worker of getPlanWorkers(spaceId)) {
    if (!isPlanWorkerBusy(spaceId, worker.windowId)) continue;
    worker.stop?.();
  }
}
