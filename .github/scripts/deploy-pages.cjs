const { setTimeout: sleep } = require("node:timers/promises");

const deployments = "/repos/{owner}/{repo}/pages/deployments";
const deployment = `${deployments}/{pages_deployment_id}`;
const pollIntervalMs = 5000;
const terminalFailures = new Set([
  "deployment_cancelled",
  "deployment_content_failed",
  "deployment_failed",
  "deployment_lost",
  "deployment_perms_error",
]);

function statusRetryDelay(error, previousErrors) {
  const { status, response } = error;
  const headers = response?.headers ?? {};
  const retryAfter = headers["retry-after"]?.trim();
  const primaryLimitReached = headers["x-ratelimit-remaining"] === "0";
  const rateLimited = status === 429 ||
    (status === 403 && (retryAfter || primaryLimitReached || /\brate limit\b/i.test(error.message)));

  if (!rateLimited && status !== 404 && !(status >= 500 && status < 600)) return null;

  if (retryAfter) {
    const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (!Number.isNaN(delay)) return Math.max(pollIntervalMs, delay);
  }
  if (rateLimited && primaryLimitReached) {
    const reset = Number(headers["x-ratelimit-reset"]) * 1000;
    if (reset > 0) return Math.max(pollIntervalMs, reset - Date.now());
  }
  return rateLimited ? 60_000 * 2 ** Math.min(previousErrors, 4) : pollIntervalMs;
}

async function deployPages(github, context, core, uploadedId, {
  cancellation = new AbortController().signal,
  timeoutMs = 600_000,
  wait = sleep,
} = {}) {
  const artifactId = Number(uploadedId);
  if (!/^\d+$/.test(uploadedId) || !Number.isSafeInteger(artifactId) || artifactId < 1) {
    throw new Error("The Pages upload did not provide a valid artifact ID.");
  }

  // Deploy the exact upload. A new lookup by name can miss a just-finalized artifact.
  const oidcToken = await core.getIDToken();
  cancellation.throwIfAborted();
  const { data: created } = await github.request(`POST ${deployments}`, {
    ...context.repo,
    artifact_id: artifactId,
    pages_build_version: context.sha,
    oidc_token: oidcToken,
  });
  const target = { ...context.repo, pages_deployment_id: created.id ?? context.sha };
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(timeoutMs)]);
  let finished = false;
  let consecutiveErrors = 0;
  let lastStatus;
  try {
    core.setOutput("page_url", created.page_url);
    for (;;) {
      signal.throwIfAborted();
      let status;
      try {
        const { data } = await github.request(`GET ${deployment}`, { ...target, request: { signal } });
        status = data.status;
        consecutiveErrors = 0;
      } catch (error) {
        signal.throwIfAborted();
        const retryDelayMs = statusRetryDelay(error, consecutiveErrors);
        if (retryDelayMs === null) throw error;
        consecutiveErrors += 1;
        core.warning(`Unable to read the Pages deployment status (HTTP ${error.status}). Retrying.`);
        await wait(Math.min(retryDelayMs, timeoutMs), undefined, { signal });
        continue;
      }
      if (status !== undefined && status !== lastStatus) {
        core.info(`Pages deployment status: ${status}`);
        lastStatus = status;
      }
      if (status === "succeed") {
        finished = true;
        return;
      }
      if (terminalFailures.has(status)) {
        finished = true;
        throw new Error(`The Pages deployment ended with status: ${status}.`);
      }
      await wait(pollIntervalMs, undefined, { signal });
    }
  } finally {
    if (!finished) {
      try {
        await github.request(`POST ${deployment}/cancel`, {
          ...target,
          request: { signal: AbortSignal.timeout(5000) },
        });
      } catch {
        core.warning("Unable to cancel the pending Pages deployment.");
      }
    }
  }
}

module.exports = { deployPages };
