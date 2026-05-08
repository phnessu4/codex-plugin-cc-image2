import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

function readPlugin(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("image command spec wires the slash command to codex-companion image subcommand", () => {
  const source = readPlugin("commands/image.md");
  assert.match(source, /Bash\(node:\*\)/);
  assert.match(source, /codex-companion\.mjs" image \$ARGUMENTS/);
  assert.match(source, /image_generation tool \(gpt-image-2\)/);
  assert.match(source, /\.image-gen\.lock/);
  assert.match(source, /generated_images/);
  assert.match(source, /50\s*KB/);
  assert.match(source, /Forward the helper output verbatim/i);
  assert.match(source, /\/codex:setup/);
});

test("image subcommand rejects an empty prompt", () => {
  const result = run("node", [SCRIPT, "image", "--size", "1024x1024", "--output", "/tmp/should-not-exist.png", ""], {
    cwd: ROOT
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a prompt/i);
});

test("image subcommand rejects sizes that are not multiples of 16", () => {
  const result = run("node", [SCRIPT, "image", "--size", "1023x1024", "--output", "/tmp/should-not-exist.png", "anything"], {
    cwd: ROOT
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --size/);
});

test("image subcommand rejects custom WxH sizes outside the named set", () => {
  // Custom WxH (even when 16-aligned and within 16-3840) is no longer accepted —
  // backend may silently ignore custom dims (e.g. 1024x1024 returning ~1254x1254
  // observed in practice). Restrict to the officially documented set.
  for (const size of ["4096x1024", "768x1280", "2048x2048", "512x512"]) {
    const result = run("node", [SCRIPT, "image", "--size", size, "--output", "/tmp/should-not-exist.png", "anything"], {
      cwd: ROOT
    });
    assert.notEqual(result.status, 0, `Expected size "${size}" to be rejected`);
    assert.match(result.stderr, /Invalid --size/);
    assert.match(result.stderr, /1024x1024 \| 1024x1536 \| 1536x1024 \| auto/);
  }
});

test("image subcommand accepts only the four named sizes", () => {
  for (const size of ["1024x1024", "1536x1024", "1024x1536", "auto"]) {
    const result = run("node", [SCRIPT, "image", "--size", size, "--output", "/tmp/should-not-exist.png", ""], {
      cwd: ROOT
    });
    // Empty prompt still rejects — but the rejection must come from the prompt
    // check, not the size check. That confirms the size passed validation.
    assert.match(result.stderr, /Provide a prompt/i, `Expected size "${size}" to pass validation`);
  }
});

test("image subcommand rejects non-PNG output paths", () => {
  const result = run("node", [SCRIPT, "image", "--output", "/tmp/should-not-exist.jpg", "a red cube"], {
    cwd: ROOT
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must end with \.png/);
});

test("usage banner advertises the image subcommand", () => {
  const result = run("node", [SCRIPT, "help"], { cwd: ROOT });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /image \[--size <1024x1024\|1024x1536\|1536x1024\|auto>\]/);
  assert.match(result.stdout, /\[--effort <none\|minimal\|low\|medium\|high\|xhigh>\]/);
  assert.match(result.stdout, /image-status \[--json\]/);
});

test("image-status command spec wires the slash command to the image-status subcommand", () => {
  const source = readPlugin("commands/image-status.md");
  assert.match(source, /Bash\(node:\*\)/);
  assert.match(source, /codex-companion\.mjs" image-status \$ARGUMENTS/);
  assert.match(source, /idle/);
  assert.match(source, /busy/);
  assert.match(source, /stale/);
  assert.match(source, /Forward the helper output verbatim/i);
});

test("image-status reports idle when no lock is held and the queue is empty", () => {
  const env = { ...process.env, CODEX_HOME: fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-status-")) };
  const result = run("node", [SCRIPT, "image-status", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.lock.state, "idle");
  assert.match(payload.lock.lockPath, /\.image-gen\.lock$/);
  assert.equal(payload.queue.pendingCount, 0);
  assert.equal(payload.queue.processing, null);
});

test("image-status reports busy and includes holder details when a lock is present", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-status-"));
  const lockPath = path.join(tmpHome, ".image-gen.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, acquiredAt: "2025-01-01T00:00:00.000Z" }));
  const env = { ...process.env, CODEX_HOME: tmpHome };
  const result = run("node", [SCRIPT, "image-status", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.ok(["busy", "stale"].includes(payload.lock.state));
  assert.equal(payload.lock.holder.pid, 4242);
  assert.equal(payload.lock.holder.acquiredAt, "2025-01-01T00:00:00.000Z");
  assert.equal(payload.queue.pendingCount, 0);
});

test("image-status surfaces queue state alongside the lock", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-status-"));
  const jobsDir = path.join(tmpHome, "image-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, "img_test_pending.json"),
    JSON.stringify({
      id: "img_test_pending",
      createdAt: "2025-01-01T00:00:00.000Z",
      status: "pending",
      promptPreview: "test pending"
    })
  );
  fs.writeFileSync(
    path.join(jobsDir, "img_test_done.json"),
    JSON.stringify({
      id: "img_test_done",
      createdAt: "2025-01-01T00:00:01.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z",
      status: "done",
      result: { outputPath: "/tmp/x.png", sizeBytes: 1234567 }
    })
  );
  const env = { ...process.env, CODEX_HOME: tmpHome };
  const result = run("node", [SCRIPT, "image-status", "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.queue.pendingCount, 1);
  assert.deepEqual(payload.queue.pendingJobIds, ["img_test_pending"]);
  assert.equal(payload.queue.recentResults.length, 1);
  assert.equal(payload.queue.recentResults[0].id, "img_test_done");
  assert.equal(payload.queue.recentResults[0].status, "done");
});

test("image-enqueue rejects sizes that fail the same validation as image", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-enqueue-"));
  const env = { ...process.env, CODEX_HOME: tmpHome };
  const result = run("node", [SCRIPT, "image-enqueue", "--size", "1023x1024", "--output", "/tmp/should-not-exist.png", "anything"], {
    cwd: ROOT,
    env
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --size/);
});

test("image-result errors when the job id does not exist", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-result-"));
  const env = { ...process.env, CODEX_HOME: tmpHome };
  const result = run("node", [SCRIPT, "image-result", "img_does_not_exist"], { cwd: ROOT, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No image job found/);
});

test("image-result reads a stored job record", () => {
  const tmpHome = fs.mkdtempSync(path.join(path.sep === "/" ? "/tmp" : "C:\\Temp", "codex-image-result-"));
  const jobsDir = path.join(tmpHome, "image-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const job = {
    id: "img_test_result",
    createdAt: "2025-02-01T00:00:00.000Z",
    finishedAt: "2025-02-01T00:01:30.000Z",
    status: "done",
    result: { outputPath: "/tmp/x.png", sizeBytes: 2345678, requestedSize: "1024x1024" },
    promptPreview: "lorem"
  };
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job));
  const env = { ...process.env, CODEX_HOME: tmpHome };
  const result = run("node", [SCRIPT, "image-result", job.id, "--json"], { cwd: ROOT, env });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.id, job.id);
  assert.equal(payload.status, "done");
  assert.equal(payload.result.sizeBytes, 2345678);
});

test("image-enqueue and image-result command specs are wired", () => {
  const enq = readPlugin("commands/image-enqueue.md");
  assert.match(enq, /codex-companion\.mjs" image-enqueue \$ARGUMENTS/);
  assert.match(enq, /returns immediately/i);
  assert.match(enq, /\/codex:image-status/);
  assert.match(enq, /\/codex:image-result/);

  const res = readPlugin("commands/image-result.md");
  assert.match(res, /codex-companion\.mjs" image-result \$ARGUMENTS/);
  assert.match(res, /pending/);
  assert.match(res, /processing/);
  assert.match(res, /done/);
  assert.match(res, /failed/);
});
