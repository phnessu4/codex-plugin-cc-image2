#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const IMAGE_GEN_DIR = path.join(CODEX_HOME, "generated_images");
const IMAGE_GEN_LOCK = path.join(CODEX_HOME, ".image-gen.lock");
const IMAGE_GEN_LOG = path.join(CODEX_HOME, "image-gen-log.jsonl");
const IMAGE_JOBS_DIR = path.join(CODEX_HOME, "image-jobs");
const IMAGE_WORKER_PID_FILE = path.join(IMAGE_JOBS_DIR, "worker.pid");
// Discrete sizes explicitly listed by OpenAI's image generation guide for gpt-image-2,
// plus the documented "auto" sentinel. The API technically accepts any WxH that meets
// the constraints (edge ≤ 3840, mult of 16, ratio ≤ 3:1, 655,360 ≤ total ≤ 8,294,400)
// but in practice we have observed the backend silently reshape some sizes —
// e.g. 1024x1024 returns ~1254x1254 (same ~1.57M total pixels as the non-square 1.5M
// sizes). Restricting to the discrete listed set avoids accidentally hitting another
// silent reshape; downstream that needs exact pixels should A/B verify before relying
// on a given size. See _Workflow/IMAGE_GEN_SOP.md §6 for the 1024x1024 caveat.
//
// Sizes above 2560x1440 are flagged as experimental in the official guide.
const NAMED_IMAGE_SIZES = new Set([
  // standard tier
  "1024x1024",  // 1.05M px · square · fastest per OpenAI guide
  "1024x1536",  // 1.57M px · portrait · 2:3
  "1536x1024",  // 1.57M px · landscape · 3:2
  "2048x1152",  // 2.36M px · landscape · 16:9 (2K)
  "2048x2048",  // 4.19M px · square (2K)
  // experimental tier (> 2560x1440)
  "2160x3840",  // 8.29M px · portrait · 9:16 (4K)
  "3840x2160",  // 8.29M px · landscape · 16:9 (4K)
  // sentinel
  "auto"
]);
const MIN_VALID_IMAGE_BYTES = 50_000;
const IMAGE_LOCK_STALE_MS = 10 * 60 * 1000;
const IMAGE_LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const IMAGE_LOCK_POLL_INTERVAL_MS = 1000;
const IMAGE_PROMPT_PREVIEW_LIMIT = 200;
const IMAGE_WORKER_STALE_MS = 5 * 60 * 1000;
const IMAGE_WORKER_IDLE_EXIT_MS = 30 * 1000;
const IMAGE_WORKER_TICK_MS = 1000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs image [--size <1024x1024|1024x1536|1536x1024|2048x1152|2048x2048|2160x3840|3840x2160|auto>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt]",
      "  node scripts/codex-companion.mjs image-ref --ref <path>[,<path>...] [--ref <path>]... [--size <1024x1024|1024x1536|1536x1024|2048x1152|2048x2048|2160x3840|3840x2160|auto>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt]",
      "  node scripts/codex-companion.mjs image-enqueue [--size <1024x1024|1024x1536|1536x1024|2048x1152|2048x2048|2160x3840|3840x2160|auto>] [--output <path>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--prompt-file <path>] [--cwd <path>] [--json] [prompt]",
      "  node scripts/codex-companion.mjs image-status [--json]",
      "  node scripts/codex-companion.mjs image-result <job-id> [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

function previewPrompt(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= IMAGE_PROMPT_PREVIEW_LIMIT) {
    return flat;
  }
  return `${flat.slice(0, IMAGE_PROMPT_PREVIEW_LIMIT - 3)}...`;
}

function classifyImageGenError({ message, stderr }) {
  const haystack = `${message ?? ""}\n${stderr ?? ""}`.toLowerCase();
  if (/rate.?limit|quota|429|too many requests|usage cap|usage limit|exceed/.test(haystack)) {
    return "quota";
  }
  if (/auth|login|credential|unauthori[sz]ed|401|forbidden|403/.test(haystack)) {
    return "auth";
  }
  if (/reconnect|stream|timeout|network|econn|enetunreach|etimedout/.test(haystack)) {
    return "network";
  }
  if (/no png|did not produce|placeholder|hallucinat/.test(haystack)) {
    return "no_image";
  }
  if (/invalid|must end|out of range|multiples of/.test(haystack)) {
    return "invalid_input";
  }
  if (/sandbox/.test(haystack)) {
    return "sandbox";
  }
  return "unknown";
}

function appendImageGenLog(entry) {
  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    fs.appendFileSync(IMAGE_GEN_LOG, `${JSON.stringify(entry)}\n`);
  } catch (_err) {
    // logging must never throw
  }
}

function isValidImageSize(size) {
  return NAMED_IMAGE_SIZES.has(size);
}

function buildImageTurnPrompt({ promptText, size, outputPath, hasRefs = false }) {
  const sanitized = String(promptText).replace(/\s+/g, " ").trim();
  const lines = [
    "Use your built-in image_generation tool (gpt-image-2) to generate exactly one image.",
    `Image size: ${size}.`,
    `Save the resulting PNG as ${outputPath}.`,
    "Do not perform any other action: do not list directories, run searches, copy files manually, or write code.",
    "After generation, reply with only the absolute file path on a single line — no other text.",
    ""
  ];
  if (hasRefs) {
    lines.push(
      "The attached image(s) are reference inputs. Use them as character/scene/prop anchors — preserve facial structure, costume detail, set staging, and prop appearance from the references. The text prompt below describes the new shot composition; the references provide visual identity.",
      ""
    );
  }
  lines.push("Image prompt:", sanitized);
  return lines.join("\n");
}

function findLatestSessionImage(sessionId) {
  if (!sessionId) {
    return null;
  }
  const sessionDir = path.join(IMAGE_GEN_DIR, sessionId);
  let entries;
  try {
    entries = fs.readdirSync(sessionDir);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const pngs = entries
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .map((name) => {
      const fullPath = path.join(sessionDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pngs.length > 0 ? pngs[0].fullPath : null;
}

function readImageGenLockHolder() {
  let raw;
  try {
    raw = fs.readFileSync(IMAGE_GEN_LOCK, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null
    };
  } catch (_err) {
    return { pid: null, acquiredAt: null };
  }
}

function readImageGenLockState({ staleMs = IMAGE_LOCK_STALE_MS } = {}) {
  let stat;
  try {
    stat = fs.statSync(IMAGE_GEN_LOCK);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { state: "idle", lockPath: IMAGE_GEN_LOCK };
    }
    throw err;
  }
  const holder = readImageGenLockHolder();
  const ageMs = Date.now() - stat.mtimeMs;
  return {
    state: ageMs > staleMs ? "stale" : "busy",
    lockPath: IMAGE_GEN_LOCK,
    holder,
    ageMs,
    staleThresholdMs: staleMs
  };
}

async function acquireImageGenLock({
  pollIntervalMs = IMAGE_LOCK_POLL_INTERVAL_MS,
  timeoutMs = IMAGE_LOCK_WAIT_TIMEOUT_MS,
  staleMs = IMAGE_LOCK_STALE_MS,
  onWait = null
} = {}) {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const start = Date.now();
  let waitNotified = false;
  while (true) {
    let fd;
    try {
      fd = fs.openSync(IMAGE_GEN_LOCK, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(IMAGE_GEN_LOCK).mtimeMs;
      } catch (statErr) {
        if (statErr.code === "ENOENT") {
          continue;
        }
        throw statErr;
      }
      if (Date.now() - mtimeMs > staleMs) {
        try {
          fs.unlinkSync(IMAGE_GEN_LOCK);
        } catch (unlinkErr) {
          if (unlinkErr.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
        continue;
      }
      if (!waitNotified && typeof onWait === "function") {
        waitNotified = true;
        try {
          onWait({ holder: readImageGenLockHolder(), ageMs: Date.now() - mtimeMs });
        } catch (_err) {
          // ignore notification failures
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Image generation lock at ${IMAGE_GEN_LOCK} held for >${Math.round(timeoutMs / 1000)}s. Aborting.`
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }

    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, acquiredAt: nowIso() })
    );
    fs.closeSync(fd);
    return {
      release: () => {
        try {
          fs.unlinkSync(IMAGE_GEN_LOCK);
        } catch (err) {
          if (err.code !== "ENOENT") {
            throw err;
          }
        }
      }
    };
  }
}

const VALID_REF_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function resolveImageGenRequest({ promptText, size, outputArg, cwd, model, effort, refs }) {
  if (!promptText || !String(promptText).trim()) {
    throw new Error("Provide a prompt, a --prompt-file, or piped stdin describing the image.");
  }
  const requestedSize = size ?? "1024x1024";
  if (!isValidImageSize(requestedSize)) {
    throw new Error(
      `Invalid --size "${requestedSize}". Allowed values: 1024x1024 | 1024x1536 | 1536x1024 | 2048x1152 | 2048x2048 | 2160x3840 | 3840x2160 | auto. (Sizes above 2560x1440 are experimental per OpenAI guide.)`
    );
  }
  const defaultName = `codex_image_${Date.now()}.png`;
  const outputPath = path.resolve(cwd, outputArg ?? `./${defaultName}`);
  if (!outputPath.toLowerCase().endsWith(".png")) {
    throw new Error(`--output must end with .png; got "${outputPath}".`);
  }
  const resolvedRefs = (refs ?? []).map((p) => path.resolve(cwd, p));
  for (const refPath of resolvedRefs) {
    if (!fs.existsSync(refPath)) {
      throw new Error(`--ref file not found: ${refPath}`);
    }
    const ext = path.extname(refPath).toLowerCase();
    if (!VALID_REF_EXTENSIONS.has(ext)) {
      throw new Error(`--ref must be a PNG/JPG/WebP image; got "${refPath}"`);
    }
  }
  return {
    cwd,
    promptText: String(promptText),
    size: requestedSize,
    outputPath,
    model: normalizeRequestedModel(model),
    effort: normalizeReasoningEffort(effort),
    refs: resolvedRefs
  };
}

async function executeImageGen(request, { onLockWait } = {}) {
  fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
  ensureCodexAvailable(request.cwd);

  const startedAt = Date.now();
  const startedAtIso = nowIso();
  const promptPreview = previewPrompt(request.promptText);
  const baseLogEntry = {
    ts: startedAtIso,
    cwd: request.cwd,
    output_path: request.outputPath,
    requested_size: request.size,
    model: request.model,
    effort: request.effort,
    prompt_preview: promptPreview,
    prompt_length: request.promptText.length
  };

  const lock = await acquireImageGenLock({
    onWait: (info) => {
      const heldBy = info.holder?.pid ? ` by pid ${info.holder.pid}` : "";
      const since = info.holder?.acquiredAt ? ` since ${info.holder.acquiredAt}` : "";
      const message = `[codex:image] waiting for ~/.codex/.image-gen.lock (held${heldBy}${since}) — image generations are serialized to avoid ChatGPT stream breaks.\n`;
      if (typeof onLockWait === "function") {
        try {
          onLockWait({ ...info, message });
        } catch (_err) {
          // ignore notifier failures
        }
      } else {
        process.stderr.write(message);
      }
    }
  });

  let result;
  try {
    try {
      result = await runAppServerTurn(request.cwd, {
        prompt: buildImageTurnPrompt({
          promptText: request.promptText,
          size: request.size,
          outputPath: request.outputPath,
          hasRefs: (request.refs ?? []).length > 0
        }),
        defaultPrompt: "",
        model: request.model,
        effort: request.effort,
        sandbox: "workspace-write",
        persistThread: false,
        threadName: null,
        refs: request.refs ?? []
      });
    } catch (err) {
      const errorClass = classifyImageGenError({ message: err?.message, stderr: "" });
      appendImageGenLog({
        ...baseLogEntry,
        finished_at: nowIso(),
        duration_ms: Date.now() - startedAt,
        status: "error",
        error_class: errorClass,
        error_message: String(err?.message ?? err)
      });
      throw err;
    }
  } finally {
    lock.release();
  }

  const sessionId = result?.threadId ?? null;
  let resolvedImage = null;

  if (fs.existsSync(request.outputPath)) {
    const sz = fs.statSync(request.outputPath).size;
    if (sz >= MIN_VALID_IMAGE_BYTES) {
      resolvedImage = request.outputPath;
    }
  }

  if (!resolvedImage) {
    const sessionImage = findLatestSessionImage(sessionId);
    if (sessionImage) {
      fs.copyFileSync(sessionImage, request.outputPath);
      resolvedImage = request.outputPath;
    }
  }

  if (!resolvedImage) {
    const detail = sessionId
      ? `Checked ${request.outputPath} and ${path.join(IMAGE_GEN_DIR, sessionId)} — neither contained a PNG.`
      : `Checked ${request.outputPath}; no Codex thread id was captured so the session directory could not be inspected.`;
    const stderrSnippet = result?.stderr ? `\nCodex stderr: ${String(result.stderr).trim()}` : "";
    const message = `Image generation produced no PNG. ${detail}${stderrSnippet}`;
    const errorClass = classifyImageGenError({
      message,
      stderr: result?.stderr ?? ""
    });
    appendImageGenLog({
      ...baseLogEntry,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedAt,
      thread_id: sessionId,
      status: "error",
      error_class: errorClass,
      error_message: message,
      codex_status: result?.status ?? null,
      codex_final_message: previewPrompt(result?.finalMessage ?? "")
    });
    throw new Error(message);
  }

  const stats = fs.statSync(resolvedImage);
  if (stats.size < MIN_VALID_IMAGE_BYTES) {
    const message = `Output image is suspiciously small (${stats.size} bytes); likely a placeholder or hallucinated success. Path: ${resolvedImage}`;
    appendImageGenLog({
      ...baseLogEntry,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedAt,
      thread_id: sessionId,
      status: "error",
      error_class: "no_image",
      error_message: message,
      size_bytes: stats.size
    });
    throw new Error(message);
  }

  const payload = {
    status: "ok",
    outputPath: resolvedImage,
    sizeBytes: stats.size,
    requestedSize: request.size,
    threadId: sessionId,
    sessionImageDir: sessionId ? path.join(IMAGE_GEN_DIR, sessionId) : null
  };

  appendImageGenLog({
    ...baseLogEntry,
    finished_at: nowIso(),
    duration_ms: Date.now() - startedAt,
    thread_id: sessionId,
    status: "ok",
    size_bytes: stats.size
  });

  return payload;
}

async function handleImage(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "size", "output", "prompt-file", "cwd"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model",
      s: "size",
      o: "output"
    }
  });

  const cwd = resolveCommandCwd(options);
  const promptText = readTaskPrompt(cwd, options, positionals);
  const request = resolveImageGenRequest({
    promptText,
    size: options.size,
    outputArg: options.output,
    cwd,
    model: options.model,
    effort: options.effort
  });
  const payload = await executeImageGen(request);
  outputCommandResult(payload, `${payload.outputPath}\n`, options.json);
}

async function handleImageRef(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "size", "output", "prompt-file", "cwd"],
    arrayOptions: ["ref"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model",
      s: "size",
      o: "output",
      r: "ref"
    }
  });

  const refs = options.ref ?? [];
  if (refs.length === 0) {
    throw new Error(
      "/codex:image-ref requires at least one --ref <path> (image-to-image / reference). For text-only generation use /codex:image."
    );
  }

  const cwd = resolveCommandCwd(options);
  const promptText = readTaskPrompt(cwd, options, positionals);
  const request = resolveImageGenRequest({
    promptText,
    size: options.size,
    outputArg: options.output,
    cwd,
    model: options.model,
    effort: options.effort,
    refs
  });
  const payload = await executeImageGen(request);
  outputCommandResult(payload, `${payload.outputPath}\n`, options.json);
}

function generateImageJobId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `img_${stamp}_${rand}`;
}

function imageJobPath(jobId) {
  return path.join(IMAGE_JOBS_DIR, `${jobId}.json`);
}

function readImageJob(jobId) {
  let raw;
  try {
    raw = fs.readFileSync(imageJobPath(jobId), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function writeImageJob(record) {
  fs.mkdirSync(IMAGE_JOBS_DIR, { recursive: true });
  const tmp = `${imageJobPath(record.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, imageJobPath(record.id));
}

function listImageJobs(filter = () => true) {
  let entries;
  try {
    entries = fs.readdirSync(IMAGE_JOBS_DIR);
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const job = readImageJob(id);
    if (job && filter(job)) {
      jobs.push(job);
    }
  }
  jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return jobs;
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readImageWorkerPid() {
  let raw;
  try {
    raw = fs.readFileSync(IMAGE_WORKER_PID_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const pid = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function clearStaleImageWorkerPid() {
  const pid = readImageWorkerPid();
  if (pid === null) {
    return;
  }
  if (!isPidAlive(pid)) {
    try {
      fs.unlinkSync(IMAGE_WORKER_PID_FILE);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

function spawnImageWorker() {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, "image-worker"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true
  });
  child.unref();
  return child;
}

function ensureImageWorkerRunning() {
  fs.mkdirSync(IMAGE_JOBS_DIR, { recursive: true });
  clearStaleImageWorkerPid();
  const pid = readImageWorkerPid();
  if (pid && isPidAlive(pid)) {
    return { spawned: false, pid };
  }
  const child = spawnImageWorker();
  return { spawned: true, pid: child.pid ?? null };
}

async function handleImageEnqueue(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "size", "output", "prompt-file", "cwd"],
    booleanOptions: ["json"],
    aliasMap: {
      m: "model",
      s: "size",
      o: "output"
    }
  });

  const cwd = resolveCommandCwd(options);
  const promptText = readTaskPrompt(cwd, options, positionals);
  const request = resolveImageGenRequest({
    promptText,
    size: options.size,
    outputArg: options.output,
    cwd,
    model: options.model,
    effort: options.effort
  });

  const jobId = generateImageJobId();
  const createdAt = nowIso();
  const record = {
    id: jobId,
    createdAt,
    status: "pending",
    request: {
      cwd: request.cwd,
      promptText: request.promptText,
      size: request.size,
      outputPath: request.outputPath,
      model: request.model,
      effort: request.effort
    },
    promptPreview: previewPrompt(request.promptText)
  };
  writeImageJob(record);

  const worker = ensureImageWorkerRunning();
  const pending = listImageJobs((job) => job.status === "pending").length;

  const payload = {
    status: "queued",
    jobId,
    createdAt,
    promptPreview: record.promptPreview,
    requestedSize: request.size,
    outputPath: request.outputPath,
    pendingCount: pending,
    workerPid: worker.pid,
    workerSpawned: worker.spawned
  };
  const rendered = `Enqueued ${jobId} (${pending} pending). Worker pid ${worker.pid ?? "unknown"}${
    worker.spawned ? " (spawned)" : ""
  }. Check /codex:image-status or /codex:image-result ${jobId}.\n`;
  outputCommandResult(payload, rendered, options.json);
}

async function handleImageWorker() {
  fs.mkdirSync(IMAGE_JOBS_DIR, { recursive: true });
  // Acquire worker pid file atomically.
  let pidHandle;
  try {
    pidHandle = fs.openSync(IMAGE_WORKER_PID_FILE, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
    const existing = readImageWorkerPid();
    if (existing && isPidAlive(existing)) {
      // Another worker is already running.
      return;
    }
    // Stale; remove and retry once.
    try {
      fs.unlinkSync(IMAGE_WORKER_PID_FILE);
    } catch (rmErr) {
      if (rmErr.code !== "ENOENT") {
        throw rmErr;
      }
    }
    pidHandle = fs.openSync(IMAGE_WORKER_PID_FILE, "wx");
  }
  fs.writeSync(pidHandle, String(process.pid));
  fs.closeSync(pidHandle);

  let idleSince = null;
  try {
    while (true) {
      const pending = listImageJobs((job) => job.status === "pending");
      if (pending.length === 0) {
        if (idleSince === null) {
          idleSince = Date.now();
        } else if (Date.now() - idleSince > IMAGE_WORKER_IDLE_EXIT_MS) {
          break;
        }
        await sleep(IMAGE_WORKER_TICK_MS);
        continue;
      }
      idleSince = null;

      const job = pending[0];
      job.status = "processing";
      job.startedAt = nowIso();
      job.workerPid = process.pid;
      writeImageJob(job);

      try {
        const payload = await executeImageGen(job.request, {
          onLockWait: () => {
            // worker is the lock holder; not expected to wait, but tolerate it
          }
        });
        job.status = "done";
        job.finishedAt = nowIso();
        job.result = payload;
        writeImageJob(job);
      } catch (err) {
        const errorMessage = String(err?.message ?? err);
        const errorClass = classifyImageGenError({ message: errorMessage, stderr: "" });
        job.status = "failed";
        job.finishedAt = nowIso();
        job.error = { class: errorClass, message: errorMessage };
        writeImageJob(job);
      }
    }
  } finally {
    try {
      const current = readImageWorkerPid();
      if (current === process.pid) {
        fs.unlinkSync(IMAGE_WORKER_PID_FILE);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        // best effort
      }
    }
  }
}

function handleImageResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, e.g. `image-result img_abc_123`.");
  }
  const job = readImageJob(jobId);
  if (!job) {
    throw new Error(`No image job found for id "${jobId}".`);
  }
  let rendered;
  if (job.status === "done") {
    rendered = `Job ${job.id}: done. Image at ${job.result?.outputPath ?? "<unknown>"} (${job.result?.sizeBytes ?? "?"} bytes).\n`;
  } else if (job.status === "failed") {
    rendered = `Job ${job.id}: failed (${job.error?.class ?? "unknown"}). ${job.error?.message ?? ""}\n`;
  } else {
    rendered = `Job ${job.id}: ${job.status}. Created ${job.createdAt}, started ${job.startedAt ?? "—"}.\n`;
  }
  outputCommandResult(job, rendered, options.json);
}

function buildImageQueueSnapshot() {
  clearStaleImageWorkerPid();
  const jobs = listImageJobs(() => true);
  const pending = jobs.filter((job) => job.status === "pending");
  const processing = jobs.find((job) => job.status === "processing") ?? null;
  const recent = jobs
    .filter((job) => job.status === "done" || job.status === "failed")
    .slice(-5);
  const workerPid = readImageWorkerPid();
  const workerAlive = workerPid !== null && isPidAlive(workerPid);
  return {
    workerPid,
    workerAlive,
    pendingCount: pending.length,
    pendingJobIds: pending.map((job) => job.id),
    processing: processing
      ? {
          id: processing.id,
          startedAt: processing.startedAt,
          promptPreview: processing.promptPreview
        }
      : null,
    recentResults: recent.map((job) => ({
      id: job.id,
      status: job.status,
      finishedAt: job.finishedAt,
      errorClass: job.error?.class ?? null
    }))
  };
}

function handleImageStatus(argv) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ["json"]
  });
  const lockSnapshot = readImageGenLockState();
  const queueSnapshot = buildImageQueueSnapshot();

  const lines = [];
  if (lockSnapshot.state === "idle") {
    lines.push(`Lock: idle (${lockSnapshot.lockPath} absent)`);
  } else if (lockSnapshot.state === "stale") {
    const ageSeconds = Math.round((lockSnapshot.ageMs ?? 0) / 1000);
    lines.push(
      `Lock: stale (age ${ageSeconds}s > ${Math.round(lockSnapshot.staleThresholdMs / 1000)}s threshold; will be reclaimed)`
    );
  } else {
    const ageSeconds = Math.round((lockSnapshot.ageMs ?? 0) / 1000);
    const heldBy = lockSnapshot.holder?.pid ? ` pid ${lockSnapshot.holder.pid}` : "";
    const since = lockSnapshot.holder?.acquiredAt ? ` since ${lockSnapshot.holder.acquiredAt}` : "";
    lines.push(`Lock: busy${heldBy}${since} (age ${ageSeconds}s)`);
  }
  if (queueSnapshot.workerPid !== null) {
    lines.push(
      `Worker: pid ${queueSnapshot.workerPid} ${queueSnapshot.workerAlive ? "alive" : "stale (will be respawned on next enqueue)"}`
    );
  } else {
    lines.push("Worker: not running");
  }
  lines.push(`Pending jobs: ${queueSnapshot.pendingCount}`);
  if (queueSnapshot.processing) {
    lines.push(
      `Processing: ${queueSnapshot.processing.id} (started ${queueSnapshot.processing.startedAt ?? "?"})`
    );
  }
  if (queueSnapshot.recentResults.length > 0) {
    lines.push("Recent:");
    for (const entry of queueSnapshot.recentResults) {
      const tag = entry.status === "done" ? "ok" : `failed (${entry.errorClass ?? "unknown"})`;
      lines.push(`  - ${entry.id} ${tag} @ ${entry.finishedAt ?? "?"}`);
    }
  }

  const payload = {
    lock: lockSnapshot,
    queue: queueSnapshot
  };
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "image":
      await handleImage(argv);
      break;
    case "image-ref":
      await handleImageRef(argv);
      break;
    case "image-enqueue":
      await handleImageEnqueue(argv);
      break;
    case "image-worker":
      await handleImageWorker();
      break;
    case "image-result":
      handleImageResult(argv);
      break;
    case "image-status":
      handleImageStatus(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
