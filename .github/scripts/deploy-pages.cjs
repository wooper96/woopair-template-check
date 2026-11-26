const { setTimeout: sleep } = require("node:timers/promises");

const deployments = "/repos/{owner}/{repo}/pages/deployments";
const deployment = `${deployments}/{pages_deployment_id}`;
const retryableDeploymentFailure = "deployment_failed";
const pollIntervalMs = 5000;
const terminalFailures = new Set([
  "deployment_cancelled",
  "deployment_content_failed",
  retryableDeploymentFailure,
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
  core.info(`Pages deployment ${target.pages_deployment_id}, commit ${context.sha}, artifact ${artifactId}.`);
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
        throw Object.assign(new Error(`The Pages deployment ended with status: ${status}.`), { pagesStatus: status });
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

async function deployWithRecovery(github, context, core, artifactId, options) {
  try {
    await deployPages(github, context, core, artifactId, options);
  } catch (error) {
    if (error.pagesStatus !== retryableDeploymentFailure) throw safeWorkflowError(error);
    core.warning("Pages ended the first deployment with a failure. WooPair will try once more with a fresh upload.");
    core.setOutput("retry", "true");
  }
}

async function retryPages(github, context, core, artifactId, options) {
  try {
    const { repo } = context;
    const { data: pages } = await github.request("GET /repos/{owner}/{repo}/pages", repo);
    if (pages.build_type !== "workflow") throw new Error("Select GitHub Actions as the Pages source before retrying.");
    const { data: head } = await github.request("GET /repos/{owner}/{repo}/git/ref/heads/main", repo);
    if (head.object.sha !== context.sha) {
      core.info("A newer commit replaced this deployment.");
      return;
    }
    await deployPages(github, context, core, artifactId, options);
  } catch (error) {
    throw safeWorkflowError(error);
  }
}

function safeWorkflowError(error) {
  if (!Number.isInteger(error.status)) return error;
  const requestId = error.response?.headers?.["x-github-request-id"];
  const request = typeof requestId === "string" && /^[A-F0-9:]{1,100}$/i.test(requestId) ? `, request ${requestId}` : "";
  // Request errors can carry the deployment request body, including the OIDC token.
  return new Error(`GitHub API request failed (HTTP ${error.status}${request}).`);
}

module.exports = { deployPages, deployWithRecovery, retryPages };
