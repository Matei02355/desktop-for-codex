const { spawn } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");
const readline = require("readline");

const appData = process.env.APPDATA || "";
const programFiles = process.env.ProgramFiles || "";
const candidates = [
  appData ? path.join(appData, "npm", "codex.cmd") : "",
  appData ? path.join(appData, "npm", "codex.exe") : "",
  programFiles ? path.join(programFiles, "nodejs", "codex.cmd") : "",
  programFiles ? path.join(programFiles, "nodejs", "codex.exe") : "",
  "codex"
].filter(Boolean);

const codexBin = candidates.find((candidate) => candidate === "codex" || existsSync(candidate)) || "codex";

const child = spawn(codexBin, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  shell: codexBin.toLowerCase().endsWith(".cmd") || codexBin.toLowerCase().endsWith(".bat")
});

const out = readline.createInterface({ input: child.stdout });
const err = readline.createInterface({ input: child.stderr });

const sent = new Set();
const done = new Set();

function send(msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(id, method, params = {}) {
  send({ jsonrpc: "2.0", id, method, params });
}

function sendInitialize() {
  if (sent.has("init")) {
    return;
  }
  sent.add("init");
  request(1, "initialize", {
    clientInfo: {
      name: "probe",
      version: "0.0.1"
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: null
    }
  });
}

setTimeout(() => {
  sendInitialize();
}, 25);

out.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  console.log(`OUT ${trimmed}`);

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (parsed && parsed.id === 1 && !sent.has("account")) {
    send({
      jsonrpc: "2.0",
      method: "initialized"
    });

    sent.add("account");
    request(2, "account/read", {
      refreshToken: true
    });
    request(3, "account/rateLimits/read", null);
    request(4, "thread/list", {
      limit: 1
    });
  }

  if (parsed && parsed.id === 2) {
    done.add("account");
  }
  if (parsed && parsed.id === 3) {
    done.add("rate");
  }
  if (done.has("account") && done.has("rate")) {
    setTimeout(() => child.kill(), 300);
  }
});

err.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  console.log(`ERR ${trimmed}`);
});

child.on("close", (code) => {
  console.log(`CLOSE ${code}`);
});

setTimeout(() => {
  console.log("TIMEOUT_KILL");
  child.kill();
}, 15000);
