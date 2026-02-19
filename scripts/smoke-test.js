const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const exeCandidates = [
  path.join(rootDir, "dist", "CodexDesktop-0.1.0-x64.exe"),
  path.join(rootDir, "dist", "win-unpacked", "Codex Desktop.exe")
];

const exePath = exeCandidates.find((candidate) => fs.existsSync(candidate));
if (!exePath) {
  console.error("Smoke test failed: no built EXE found.");
  for (const candidate of exeCandidates) {
    console.error(`- Missing: ${candidate}`);
  }
  process.exit(1);
}

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const tasklistPath = path.join(systemRoot, "System32", "tasklist.exe");
const taskkillPath = path.join(systemRoot, "System32", "taskkill.exe");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTasklist(pid) {
  return spawnSync(tasklistPath, ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`], {
    encoding: "utf8",
    windowsHide: true
  });
}

function isRunning(pid) {
  const result = readTasklist(pid);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/no tasks are running/i.test(output)) {
    return false;
  }
  if (result.status !== 0) {
    return false;
  }
  return output.includes(`"${pid}"`);
}

function killPid(pid) {
  return spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
    encoding: "utf8",
    windowsHide: true
  });
}

async function main() {
  console.log(`Launching: ${exePath}`);

  const child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  if (!child.pid) {
    console.error("Smoke test failed: launch returned no PID.");
    process.exit(1);
  }

  const launchedPid = child.pid;
  child.unref();
  console.log(`Launched PID: ${launchedPid}`);

  await sleep(7000);
  if (!isRunning(launchedPid)) {
    console.error("Smoke test failed: app exited before validation window.");
    process.exit(1);
  }

  console.log("App is running. Stopping by PID...");
  const killResult = killPid(launchedPid);
  const killOutput = `${killResult.stdout || ""}\n${killResult.stderr || ""}`.trim();
  if (killOutput) {
    console.log(killOutput);
  }
  if (killResult.status !== 0) {
    console.error(`Smoke test failed: taskkill exited with ${killResult.status}.`);
    process.exit(killResult.status || 1);
  }

  await sleep(1200);
  if (isRunning(launchedPid)) {
    console.error("Smoke test failed: process still running after taskkill.");
    process.exit(1);
  }

  console.log("Smoke test passed.");
}

main().catch((error) => {
  console.error("Smoke test failed:", error && error.message ? error.message : error);
  process.exit(1);
});
