const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const path = require("path");
const readline = require("readline");

const MAX_FOLDER_ITEMS = 300;
const MAX_FOLDER_DEPTH = 2;
const MAX_COMMAND_LOG_ITEMS = 80;
const MAX_TERMINAL_LOG_ITEMS = 120;
const MAX_WORKSPACE_CHANGE_FILES = 12;
const MAX_WORKSPACE_DIFF_PREVIEW_LINES = 80;
const MAX_UNTRACKED_FILE_PREVIEW_LINES = 40;
const MAX_WORKSPACE_PREVIEW_LINE_LENGTH = 220;
const MAX_NON_GIT_TRACKED_FILES = 600;
const MAX_NON_GIT_TRACK_DEPTH = 5;
const MAX_NON_GIT_FILE_BYTES = 256 * 1024;
const MAX_NON_GIT_LOOKAHEAD_LINES = 24;
const MAX_WORKSPACE_CODE_VIEW_BYTES = 512 * 1024;
const STATE_FILENAME = "state.json";
const PASTED_IMAGES_DIRNAME = "pasted-images";
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never", "on-failure"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const NON_GIT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "bin",
  "obj"
]);
const NON_GIT_TEXT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".rb",
  ".php",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".cs",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".h",
  ".hpp",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".dart",
  ".vue",
  ".svelte",
  ".env"
]);

let mainWindow = null;
const runningProcesses = new Map();
const threadSessionPathCache = new Map();
const workspaceSnapshotCache = new Map();

function splitCommand(input) {
  const source = typeof input === "string" ? input.trim() : "";
  if (!source) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < source.length && source[i + 1] === quote) {
        current += quote;
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseCommandSpec(input) {
  const tokens = splitCommand(input);
  if (!tokens.length) {
    return {
      command: resolveCodexExecutable("codex"),
      commandArgs: []
    };
  }

  return {
    command: resolveCodexExecutable(tokens[0]),
    commandArgs: tokens.slice(1)
  };
}

function resolveCodexExecutable(command) {
  const target = typeof command === "string" ? command.trim() : "";
  if (!target) {
    return "codex";
  }

  const lower = target.toLowerCase();
  if (
    lower !== "codex" &&
    lower !== "codex.exe" &&
    lower !== "codex.cmd" &&
    lower !== "codex.bat"
  ) {
    return target;
  }

  const appData = process.env.APPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const candidatePaths = [
    appData ? path.join(appData, "npm", "codex.cmd") : "",
    appData ? path.join(appData, "npm", "codex.exe") : "",
    appData ? path.join(appData, "npm", "codex") : "",
    programFiles ? path.join(programFiles, "nodejs", "codex.cmd") : "",
    programFiles ? path.join(programFiles, "nodejs", "codex.exe") : ""
  ].filter(Boolean);

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return target;
}

function normalizeReasoningEffort(value) {
  const next = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!next) {
    return "";
  }
  if (next === "very_high" || next === "xhigh" || next === "extra_high") {
    return "high";
  }
  if (next === "minimal") {
    return "low";
  }
  if (!REASONING_EFFORTS.has(next)) {
    return "";
  }
  return next;
}

function normalizeApprovalPolicy(value) {
  const next = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!next || !APPROVAL_POLICIES.has(next)) {
    return "";
  }
  return next;
}

function shouldUseShell(command) {
  if (process.platform !== "win32" || typeof command !== "string") {
    return false;
  }
  const lower = command.trim().toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function getCommandEnvironment() {
  const env = { ...process.env };
  if (process.platform !== "win32") {
    return env;
  }

  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const preferredPathKeyOrder = ["Path", "PATH", "path"];
  const preferredPathKey = preferredPathKeyOrder.find((key) => pathKeys.includes(key));
  const pathKey = preferredPathKey || pathKeys[0] || "Path";

  let rawPath = "";
  for (const key of pathKeys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      rawPath = value;
      break;
    }
  }

  const systemRoot =
    (typeof env.SystemRoot === "string" && env.SystemRoot.trim()) ||
    (typeof env.WINDIR === "string" && env.WINDIR.trim()) ||
    "C:\\Windows";

  const requiredPathEntries = [
    path.join(systemRoot, "System32"),
    path.join(systemRoot, "System32", "Wbem"),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    systemRoot
  ];

  const seen = new Set();
  const normalizedEntries = [];
  const addPathEntry = (entry) => {
    if (typeof entry !== "string") {
      return;
    }
    const trimmed = entry.trim();
    if (!trimmed || trimmed.toLowerCase() === "%path%") {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    normalizedEntries.push(trimmed);
  };

  for (const entry of requiredPathEntries) {
    addPathEntry(entry);
  }
  for (const entry of rawPath.split(";")) {
    addPathEntry(entry);
  }

  for (const key of pathKeys) {
    if (key !== pathKey) {
      delete env[key];
    }
  }
  env[pathKey] = normalizedEntries.join(";");

  if (!env.ComSpec || !String(env.ComSpec).trim()) {
    env.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
  }

  return env;
}

function makeDefaultState() {
  return {
    settings: {
      codexCommand: "codex"
    },
    sessions: [],
    currentSessionId: null
  };
}

function sanitizeState(raw) {
  const fallback = makeDefaultState();
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const settings =
    raw.settings && typeof raw.settings === "object"
      ? {
          codexCommand:
            typeof raw.settings.codexCommand === "string" && raw.settings.codexCommand.trim()
              ? raw.settings.codexCommand.trim()
              : "codex"
        }
      : fallback.settings;

  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const currentSessionId =
    typeof raw.currentSessionId === "string" && raw.currentSessionId.trim() ? raw.currentSessionId : null;

  return {
    settings,
    sessions,
    currentSessionId
  };
}

function getStateFilePath() {
  return path.join(app.getPath("userData"), STATE_FILENAME);
}

async function loadState() {
  const statePath = getStateFilePath();
  if (!existsSync(statePath)) {
    return makeDefaultState();
  }

  try {
    const raw = await fs.readFile(statePath, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch {
    return makeDefaultState();
  }
}

async function saveState(nextState) {
  const safeState = sanitizeState(nextState);
  const statePath = getStateFilePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(safeState, null, 2), "utf8");
  return safeState;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#f4efe3",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function shouldSkipNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("WARNING: proceeding, even though we could not update PATH")) {
    return true;
  }
  return false;
}

function collectTextNode(node) {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((part) => collectTextNode(part)).join("");
  }
  if (typeof node !== "object") {
    return "";
  }

  if (typeof node.text === "string") {
    return node.text;
  }
  if (node.text && typeof node.text.value === "string") {
    return node.text.value;
  }
  if (typeof node.value === "string") {
    return node.value;
  }
  if (typeof node.delta === "string") {
    return node.delta;
  }
  if (node.content) {
    return collectTextNode(node.content);
  }
  if (node.parts) {
    return collectTextNode(node.parts);
  }
  if (node.output) {
    return collectTextNode(node.output);
  }

  return "";
}

function collectAssistantMessageText(messageLike) {
  if (!messageLike || typeof messageLike !== "object") {
    return "";
  }

  const role = typeof messageLike.role === "string" ? messageLike.role.toLowerCase() : "";
  if (role && role !== "assistant") {
    return "";
  }

  if (typeof messageLike.output_text === "string") {
    return messageLike.output_text;
  }
  if (typeof messageLike.final_text === "string") {
    return messageLike.final_text;
  }

  const content = messageLike.content || messageLike.output || messageLike.parts;
  return collectTextNode(content);
}

function joinTextFragments(fragments) {
  if (!Array.isArray(fragments) || !fragments.length) {
    return "";
  }

  const cleaned = [];
  for (const fragment of fragments) {
    const text = typeof fragment === "string" ? fragment.trim() : "";
    if (!text) {
      continue;
    }
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === text) {
      continue;
    }
    cleaned.push(text);
  }

  return cleaned.join("\n").trim();
}

function collectAssistantTextFromEvent(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  const fragments = [];
  const seen = new Set();

  const walk = (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
    const type = typeof value.type === "string" ? value.type.toLowerCase() : "";

    if (role === "assistant") {
      const assistantText = collectAssistantMessageText(value);
      if (assistantText) {
        fragments.push(assistantText);
      }
    }

    if (type === "output_text" || type === "text" || type.endsWith(".output_text")) {
      const textLike = collectTextNode(value);
      if (textLike) {
        fragments.push(textLike);
      }
    }

    if (typeof value.output_text === "string") {
      fragments.push(value.output_text);
    }
    if (typeof value.final_text === "string") {
      fragments.push(value.final_text);
    }

    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === "object") {
        walk(child);
      }
    }
  };

  walk(event);
  return joinTextFragments(fragments);
}

function normalizeCommandValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "number" || typeof part === "boolean") {
          return String(part);
        }
        return "";
      })
      .filter(Boolean);
    return parts.join(" ").trim();
  }
  return "";
}

function tryParseJsonString(input) {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function extractCommandsFromEvent(event) {
  if (!event || typeof event !== "object") {
    return [];
  }

  const commands = [];
  const seenObjects = new Set();

  const addCommand = (candidate) => {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      return;
    }
    if (command.length > 2000) {
      return;
    }
    if (!commands.includes(command)) {
      commands.push(command);
    }
  };

  const inspect = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        inspect(item);
      }
      return;
    }

    const directKeys = ["command", "cmd", "shell_command", "raw_command", "script", "command_line"];
    for (const key of directKeys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        addCommand(node[key]);
      }
    }

    const maybeJsonKeys = ["arguments", "input", "tool_input", "payload"];
    for (const key of maybeJsonKeys) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) {
        continue;
      }

      const value = node[key];
      if (typeof value === "string") {
        const parsed = tryParseJsonString(value);
        if (parsed) {
          inspect(parsed);
        }
      } else if (value && typeof value === "object") {
        inspect(value);
      }
    }

    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        inspect(child);
      }
    }
  };

  inspect(event);
  return commands;
}

function extractPlainCommandLine(line) {
  if (typeof line !== "string") {
    return "";
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("$ ")) {
    return trimmed.slice(2).trim();
  }
  if (trimmed.startsWith("> ")) {
    return trimmed.slice(2).trim();
  }
  return "";
}

function normalizeExitCodeValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeTerminalText(value) {
  const text = collectTextNode(value);
  if (!text) {
    return "";
  }
  return text.trim();
}

function formatTerminalEntry({ command = "", stdout = "", stderr = "", exitCode = null }) {
  const lines = [];
  if (command) {
    lines.push(`$ ${command}`);
  }
  if (Number.isInteger(exitCode)) {
    lines.push(`[exit ${exitCode}]`);
  }
  if (stdout) {
    lines.push(stdout);
  }
  if (stderr) {
    lines.push(`stderr:\n${stderr}`);
  }
  if (!lines.length) {
    return "";
  }
  let entry = lines.join("\n").trim();
  if (entry.length > 4000) {
    entry = `${entry.slice(0, 4000)}\n...(truncated)`;
  }
  return entry;
}

function extractTerminalEntriesFromEvent(event) {
  if (!event || typeof event !== "object") {
    return [];
  }

  const entries = [];
  const seenObjects = new Set();

  const inspect = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        inspect(item);
      }
      return;
    }

    const commandKeys = ["command", "cmd", "shell_command", "raw_command", "script", "command_line"];
    let command = "";
    for (const key of commandKeys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const next = normalizeCommandValue(node[key]);
        if (next) {
          command = next;
          break;
        }
      }
    }

    const hasStdout =
      Object.prototype.hasOwnProperty.call(node, "stdout") ||
      Object.prototype.hasOwnProperty.call(node, "std_out");
    const hasStderr =
      Object.prototype.hasOwnProperty.call(node, "stderr") ||
      Object.prototype.hasOwnProperty.call(node, "std_err") ||
      Object.prototype.hasOwnProperty.call(node, "error_output");

    const stdout = normalizeTerminalText(
      hasStdout ? node.stdout || node.std_out : node.output || node.result || node.combined_output
    );
    const stderr = normalizeTerminalText(
      hasStderr ? node.stderr || node.std_err || node.error_output : ""
    );

    const exitCode =
      normalizeExitCodeValue(node.exit_code) ??
      normalizeExitCodeValue(node.exitCode) ??
      normalizeExitCodeValue(node.code);

    const maybeEntry = formatTerminalEntry({
      command,
      stdout: command || hasStdout || hasStderr ? stdout : "",
      stderr,
      exitCode
    });

    if (maybeEntry) {
      entries.push(maybeEntry);
    }

    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        inspect(child);
      }
    }
  };

  inspect(event);
  return entries;
}

function parseIntegerLike(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function mergeUsage(current, sample) {
  if (!sample) {
    return current;
  }

  const next = { ...current };
  const keys = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
    "remainingTokens",
    "remainingRequests",
    "cumulativeInputTokens",
    "cumulativeOutputTokens",
    "cumulativeTotalTokens",
    "cumulativeReasoningTokens",
    "rateLimitPrimaryUsedPercent",
    "rateLimitSecondaryUsedPercent",
    "rateLimitPrimaryWindowMinutes",
    "rateLimitSecondaryWindowMinutes"
  ];

  for (const key of keys) {
    const value = parseIntegerLike(sample[key]);
    if (value === null) {
      continue;
    }
    if (key.startsWith("remaining") || key.startsWith("rateLimit")) {
      next[key] = value;
      continue;
    }
    if (!Number.isInteger(next[key]) || value > next[key]) {
      next[key] = value;
    }
  }

  return next;
}

function buildUsageSample(node) {
  if (!node || typeof node !== "object") {
    return null;
  }

  const tokenUsage = node.total_token_usage && typeof node.total_token_usage === "object" ? node.total_token_usage : null;
  const lastTokenUsage = node.last_token_usage && typeof node.last_token_usage === "object" ? node.last_token_usage : null;
  const rateLimits = node.rate_limits && typeof node.rate_limits === "object" ? node.rate_limits : null;
  const primaryRate = rateLimits && rateLimits.primary && typeof rateLimits.primary === "object" ? rateLimits.primary : null;
  const secondaryRate =
    rateLimits && rateLimits.secondary && typeof rateLimits.secondary === "object" ? rateLimits.secondary : null;

  const sample = {
    inputTokens: parseIntegerLike(
      node.input_tokens ?? node.inputTokens ?? node.prompt_tokens ?? (lastTokenUsage ? lastTokenUsage.input_tokens : null)
    ),
    outputTokens: parseIntegerLike(
      node.output_tokens ??
        node.outputTokens ??
        node.completion_tokens ??
        (lastTokenUsage ? lastTokenUsage.output_tokens : null)
    ),
    totalTokens: parseIntegerLike(node.total_tokens ?? node.totalTokens ?? (lastTokenUsage ? lastTokenUsage.total_tokens : null)),
    reasoningTokens: parseIntegerLike(
      node.reasoning_tokens ??
        node.reasoningTokens ??
        node.reasoning_output_tokens ??
        node.reasoningOutputTokens ??
        (lastTokenUsage ? lastTokenUsage.reasoning_output_tokens : null)
    ),
    remainingTokens: parseIntegerLike(
      node.remaining_tokens ??
        node.remainingTokens ??
        node.x_ratelimit_remaining_tokens ??
        node.ratelimit_remaining_tokens
    ),
    remainingRequests: parseIntegerLike(
      node.remaining_requests ??
        node.remainingRequests ??
        node.x_ratelimit_remaining_requests ??
        node.ratelimit_remaining_requests
    ),
    cumulativeInputTokens: parseIntegerLike(tokenUsage ? tokenUsage.input_tokens : null),
    cumulativeOutputTokens: parseIntegerLike(tokenUsage ? tokenUsage.output_tokens : null),
    cumulativeTotalTokens: parseIntegerLike(tokenUsage ? tokenUsage.total_tokens : null),
    cumulativeReasoningTokens: parseIntegerLike(tokenUsage ? tokenUsage.reasoning_output_tokens : null),
    rateLimitPrimaryUsedPercent: parseIntegerLike(
      primaryRate ? primaryRate.used_percent ?? primaryRate.usedPercent : null
    ),
    rateLimitSecondaryUsedPercent: parseIntegerLike(
      secondaryRate ? secondaryRate.used_percent ?? secondaryRate.usedPercent : null
    ),
    rateLimitPrimaryWindowMinutes: parseIntegerLike(
      primaryRate ? primaryRate.window_minutes ?? primaryRate.windowDurationMins : null
    ),
    rateLimitSecondaryWindowMinutes: parseIntegerLike(
      secondaryRate ? secondaryRate.window_minutes ?? secondaryRate.windowDurationMins : null
    )
  };

  const hasAny = Object.values(sample).some((value) => Number.isInteger(value));
  return hasAny ? sample : null;
}

function extractUsageFromEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  let usage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    remainingTokens: null,
    remainingRequests: null
  };
  const seen = new Set();

  const inspect = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const part of node) {
        inspect(part);
      }
      return;
    }

    usage = mergeUsage(usage, buildUsageSample(node));
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        inspect(child);
      }
    }
  };

  inspect(event);

  const hasAny = Object.values(usage).some((value) => Number.isInteger(value));
  return hasAny ? usage : null;
}

function extractDeltaText(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventType.includes("delta")) {
    return "";
  }
  const deltaText = collectTextNode(event.delta);
  if (deltaText) {
    return deltaText;
  }
  return collectTextNode(event.text);
}

function extractCompletedText(event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  const fromItem = collectAssistantMessageText(event.item);
  if (fromItem) {
    return fromItem;
  }

  const fromMessage = collectAssistantMessageText(event.message);
  if (fromMessage) {
    return fromMessage;
  }

  if (event.response && Array.isArray(event.response.output)) {
    const responseText = event.response.output.map((part) => collectAssistantMessageText(part)).join("");
    if (responseText) {
      return responseText;
    }
  }

  if (typeof event.output_text === "string") {
    return event.output_text;
  }

  if (typeof event.final_text === "string") {
    return event.final_text;
  }

  const fromAnyShape = collectAssistantTextFromEvent(event);
  if (fromAnyShape) {
    return fromAnyShape;
  }

  return "";
}

function buildCodexArgs(payload, outputLastMessagePath) {
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const images = Array.isArray(payload.images) ? payload.images.filter((p) => typeof p === "string" && p.trim()) : [];
  const approvalPolicy = normalizeApprovalPolicy(payload.approvalPolicy);
  const reasoningEffort = normalizeReasoningEffort(payload.reasoningEffort);
  const hasSession = typeof payload.sessionThreadId === "string" && payload.sessionThreadId.trim();
  const prefixArgs = [];
  const sandboxArgs = ["-s", "workspace-write"];

  if (process.platform === "win32") {
    // Force the modern exec path on Windows to avoid shell-style quoting regressions.
    prefixArgs.push("-c", "experimental_use_unified_exec_tool=true");
    prefixArgs.push("-c", "features.unified_exec=true");
  }

  if (approvalPolicy) {
    prefixArgs.push("-a", approvalPolicy);
  }
  if (reasoningEffort) {
    prefixArgs.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }

  if (hasSession) {
    const args = [...prefixArgs, ...sandboxArgs, "exec", "--json", "--skip-git-repo-check"];
    if (outputLastMessagePath) {
      args.push("-o", outputLastMessagePath);
    }
    args.push("resume");
    if (model) {
      args.push("-m", model);
    }
    for (const imagePath of images) {
      args.push("-i", imagePath);
    }
    args.push(payload.sessionThreadId.trim(), "-");
    return args;
  }

  const args = [...prefixArgs, ...sandboxArgs, "exec", "--json", "--skip-git-repo-check"];
  if (outputLastMessagePath) {
    args.push("-o", outputLastMessagePath);
  }
  if (model) {
    args.push("-m", model);
  }
  if (typeof payload.workspaceDir === "string" && payload.workspaceDir.trim()) {
    args.push("-C", payload.workspaceDir.trim());
  }
  for (const imagePath of images) {
    args.push("-i", imagePath);
  }
  args.push("-");
  return args;
}

function getRunCwd(payload) {
  if (typeof payload.workspaceDir === "string" && payload.workspaceDir.trim()) {
    return payload.workspaceDir.trim();
  }
  return process.cwd();
}

function getOutputLastMessagePath(requestId) {
  const safeId = typeof requestId === "string" && requestId.trim() ? requestId.trim() : "request";
  const fileName = `codex-last-message-${safeId}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  return path.join(app.getPath("userData"), fileName);
}

function getCodexSessionsRoot() {
  const userProfile = process.env.USERPROFILE || "";
  const homeDrive = process.env.HOMEDRIVE || "";
  const homePath = process.env.HOMEPATH || "";
  const homeDir = userProfile || (homeDrive && homePath ? `${homeDrive}${homePath}` : "");
  if (!homeDir) {
    return "";
  }
  return path.join(homeDir, ".codex", "sessions");
}

function sortDesc(values) {
  return values.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

async function listDirectoryEntriesSafe(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findSessionFileInDayDir(entries, dayPath, threadId) {
  if (!Array.isArray(entries) || !entries.length) {
    return "";
  }
  const needle = threadId.toLowerCase();
  const files = entries
    .filter((entry) => entry && entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl"))
    .map((entry) => entry.name);

  sortDesc(files);
  for (const fileName of files) {
    if (fileName.toLowerCase().includes(needle)) {
      return path.join(dayPath, fileName);
    }
  }
  return "";
}

async function resolveSessionFilePathByThreadId(threadId) {
  const safeThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!safeThreadId) {
    return "";
  }

  const cachedPath = threadSessionPathCache.get(safeThreadId);
  if (cachedPath && existsSync(cachedPath)) {
    return cachedPath;
  }
  if (cachedPath) {
    threadSessionPathCache.delete(safeThreadId);
  }

  const sessionsRoot = getCodexSessionsRoot();
  if (!sessionsRoot || !existsSync(sessionsRoot)) {
    return "";
  }

  const yearEntries = await listDirectoryEntriesSafe(sessionsRoot);
  const years = sortDesc(
    yearEntries
      .filter((entry) => entry && entry.isDirectory())
      .map((entry) => entry.name)
  );

  for (const year of years) {
    const yearPath = path.join(sessionsRoot, year);
    const monthEntries = await listDirectoryEntriesSafe(yearPath);
    const months = sortDesc(
      monthEntries
        .filter((entry) => entry && entry.isDirectory())
        .map((entry) => entry.name)
    );

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      const dayEntries = await listDirectoryEntriesSafe(monthPath);
      const days = sortDesc(
        dayEntries
          .filter((entry) => entry && entry.isDirectory())
          .map((entry) => entry.name)
      );

      for (const day of days) {
        const dayPath = path.join(monthPath, day);
        const fileEntries = await listDirectoryEntriesSafe(dayPath);
        const matchedFile = findSessionFileInDayDir(fileEntries, dayPath, safeThreadId);
        if (matchedFile) {
          threadSessionPathCache.set(safeThreadId, matchedFile);
          return matchedFile;
        }
      }
    }
  }

  return "";
}

function extractTokenCountInfo(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const candidates = [];
  if (record.type === "token_count") {
    candidates.push(record.info || record);
  }
  if (record.payload && typeof record.payload === "object" && record.payload.type === "token_count") {
    candidates.push(record.payload.info || record.payload);
  }
  if (
    record.msg &&
    typeof record.msg === "object" &&
    record.msg.type === "event_msg" &&
    record.msg.payload &&
    typeof record.msg.payload === "object" &&
    record.msg.payload.type === "token_count"
  ) {
    candidates.push(record.msg.payload.info || record.msg.payload);
  }
  if (record.event && typeof record.event === "object" && record.event.type === "token_count") {
    candidates.push(record.event.info || record.event);
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
  }
  return null;
}

function hasUsageValues(usage) {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  return Object.values(usage).some((value) => Number.isInteger(value));
}

async function readThreadUsageFromSessions(threadId) {
  const sessionPath = await resolveSessionFilePathByThreadId(threadId);
  if (!sessionPath) {
    return null;
  }

  let fileContent = "";
  try {
    fileContent = await fs.readFile(sessionPath, "utf8");
  } catch {
    return null;
  }

  const lines = fileContent.split(/\r?\n/g);
  let usage = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record = null;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const tokenInfo = extractTokenCountInfo(record);
    if (!tokenInfo) {
      continue;
    }

    const sample = buildUsageSample(tokenInfo);
    if (!sample) {
      continue;
    }
    usage = mergeUsage(usage || {}, sample);
  }

  return hasUsageValues(usage) ? usage : null;
}

function detectAccountInfo(loginOutput) {
  const output = typeof loginOutput === "string" ? loginOutput : "";
  const lower = output.toLowerCase();

  if (!output.trim()) {
    return {
      authMode: "unknown",
      accountLabel: "Unknown",
      providerLabel: ""
    };
  }

  if (/not logged in/i.test(output)) {
    return {
      authMode: "none",
      accountLabel: "Not signed in",
      providerLabel: ""
    };
  }

  const apiKeyMode = /(api key|with-api-key)/i.test(output);
  const chatgptMode = /chatgpt/i.test(output);

  let accountLabel = "";
  const patterns = [
    /logged in(?:\s+with\s+\w+)?\s+as\s+([^\r\n]+)/i,
    /account(?:\s+name)?\s*:\s*([^\r\n]+)/i,
    /user(?:name)?\s*:\s*([^\r\n]+)/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      accountLabel = match[1].trim();
      break;
    }
  }

  if (!accountLabel) {
    if (apiKeyMode) {
      accountLabel = "API key";
    } else if (chatgptMode) {
      accountLabel = "ChatGPT";
    } else if (lower.includes("logged in")) {
      accountLabel = "Signed in";
    } else {
      accountLabel = "Unknown";
    }
  }

  return {
    authMode: apiKeyMode ? "api-key" : chatgptMode ? "chatgpt" : "unknown",
    accountLabel,
    providerLabel: apiKeyMode ? "API key" : chatgptMode ? "ChatGPT" : ""
  };
}

async function readTextFileSafe(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return "";
  }
  try {
    const text = await fs.readFile(filePath, "utf8");
    return cleanOutputText(text);
  } catch {
    return "";
  }
}

async function deleteFileSafe(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch {
    // no-op
  }
}

function runCodex(payload) {
  return new Promise((resolve) => {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    const commandSpec = parseCommandSpec(
      typeof payload.codexCommand === "string" ? payload.codexCommand : "codex"
    );
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const outputLastMessagePath = getOutputLastMessagePath(requestId);
    const args = [...commandSpec.commandArgs, ...buildCodexArgs(payload, outputLastMessagePath)];

    let threadId =
      typeof payload.sessionThreadId === "string" && payload.sessionThreadId.trim()
        ? payload.sessionThreadId.trim()
        : null;
    let deltaText = "";
    let completedText = "";
    let rawStdout = "";
    let rawStderr = "";
    const commandLog = [];
    const seenCommands = new Set();
    const terminalLog = [];
    const seenTerminalEntries = new Set();
    let usage = {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      remainingTokens: null,
      remainingRequests: null
    };
    let sawTurnFailure = false;
    let sawErrorEvent = false;
    let settled = false;

    const recordCommand = (candidate) => {
      const command = normalizeCommandValue(candidate);
      if (!command) {
        return;
      }
      if (seenCommands.has(command)) {
        return;
      }
      seenCommands.add(command);
      commandLog.push(command);
      if (commandLog.length > MAX_COMMAND_LOG_ITEMS) {
        const removed = commandLog.shift();
        if (removed) {
          seenCommands.delete(removed);
        }
      }
    };

    const recordTerminalEntry = (entry) => {
      const text = typeof entry === "string" ? entry.trim() : "";
      if (!text) {
        return;
      }
      if (seenTerminalEntries.has(text)) {
        return;
      }
      seenTerminalEntries.add(text);
      terminalLog.push(text);
      if (terminalLog.length > MAX_TERMINAL_LOG_ITEMS) {
        const removed = terminalLog.shift();
        if (removed) {
          seenTerminalEntries.delete(removed);
        }
      }
    };

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (requestId) {
        runningProcesses.delete(requestId);
      }
      resolve(result);
    };

    const wasCancellationRequested = () => {
      if (!requestId) {
        return false;
      }
      const record = getRunningProcessRecord(requestId);
      return Boolean(record && record.cancelRequested);
    };

    const child = spawn(commandSpec.command, args, {
      cwd: getRunCwd(payload),
      windowsHide: true,
      env: getCommandEnvironment(),
      shell: shouldUseShell(commandSpec.command)
    });

    if (requestId) {
      runningProcesses.set(requestId, {
        child,
        cancelRequested: false,
        cancelRequestedAt: 0
      });
    }

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    stdoutReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const event = JSON.parse(trimmed);

        if (event && typeof event === "object") {
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            threadId = event.thread_id;
          }
          if (event.type === "error" && typeof event.message === "string") {
            sawErrorEvent = true;
            rawStderr += `${event.message}\n`;
          }
          if (event.type === "turn.failed") {
            sawTurnFailure = true;
          }

          const eventCommands = extractCommandsFromEvent(event);
          for (const command of eventCommands) {
            recordCommand(command);
          }
          const terminalEntries = extractTerminalEntriesFromEvent(event);
          for (const entry of terminalEntries) {
            recordTerminalEntry(entry);
          }
          const eventUsage = extractUsageFromEvent(event);
          if (eventUsage) {
            usage = mergeUsage(usage, eventUsage);
          }

          const nextDelta = extractDeltaText(event);
          if (nextDelta) {
            deltaText += nextDelta;
          }

          const nextCompletedText = extractCompletedText(event);
          if (nextCompletedText) {
            if (!completedText || nextCompletedText.length >= completedText.length) {
              completedText = nextCompletedText;
            } else if (!completedText.includes(nextCompletedText)) {
              completedText = `${completedText}\n${nextCompletedText}`.trim();
            }
          }
          return;
        }
      } catch {
        // Not JSON; continue to plain fallback capture.
      }

      if (!shouldSkipNoiseLine(trimmed)) {
        const plainCommand = extractPlainCommandLine(trimmed);
        if (plainCommand) {
          recordCommand(plainCommand);
        }
        if (!plainCommand) {
          recordTerminalEntry(trimmed);
        }
        rawStdout += `${line}\n`;
      }
    });

    stderrReader.on("line", (line) => {
      if (!shouldSkipNoiseLine(line)) {
        recordTerminalEntry(`stderr:\n${line.trim()}`);
        rawStderr += `${line}\n`;
      }
    });

    child.on("error", (error) => {
      const notInstalled = error && error.code === "ENOENT";
      const cancelled = wasCancellationRequested();
      finish({
        ok: false,
        cancelled,
        notInstalled,
        errorCode: cancelled ? "ECANCELLED" : error && error.code ? error.code : null,
        threadId,
        assistantText: "",
        commandLog: [...commandLog],
        terminalLog: [...terminalLog],
        usage,
        stdout: rawStdout.trim(),
        stderr: `${rawStderr}${error.message}`.trim(),
        exitCode: null
      });
      deleteFileSafe(outputLastMessagePath);
    });

    child.on("close", async (exitCode) => {
      const usageThreadId =
        (typeof threadId === "string" && threadId.trim()) ||
        (typeof payload.sessionThreadId === "string" && payload.sessionThreadId.trim()) ||
        "";
      const usageFromSession = usageThreadId ? await readThreadUsageFromSessions(usageThreadId) : null;
      if (usageFromSession) {
        usage = mergeUsage(usage, usageFromSession);
      }

      const fileOutputText = await readTextFileSafe(outputLastMessagePath);
      const hadAssistantOutput = Boolean((fileOutputText || completedText || deltaText).trim());
      const assistantText = (fileOutputText || completedText || deltaText || rawStdout || rawStderr).trim();
      const stderrText = rawStderr.trim();
      const cancelled = wasCancellationRequested();
      const isFailure = !cancelled && (exitCode !== 0 || sawTurnFailure || (sawErrorEvent && !hadAssistantOutput));

      finish({
        ok: !isFailure && !cancelled,
        cancelled,
        notInstalled: false,
        errorCode: cancelled ? "ECANCELLED" : null,
        threadId,
        assistantText,
        commandLog: [...commandLog],
        terminalLog: [...terminalLog],
        usage,
        hadAssistantOutput,
        stdout: rawStdout.trim(),
        stderr: stderrText,
        exitCode
      });
      deleteFileSafe(outputLastMessagePath);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function cleanOutputText(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !shouldSkipNoiseLine(line))
    .join("\n")
    .trim();
}

function runCommandCapture(command, args, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 15000;
  const cwd = typeof options.cwd === "string" && options.cwd.trim() ? options.cwd : process.cwd();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer = null;

    const done = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: getCommandEnvironment(),
      shell: shouldUseShell(command)
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      done({
        ok: false,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText(`${stderr}\n${error.message || ""}`),
        exitCode: null,
        errorCode: error && error.code ? error.code : null
      });
    });

    child.on("close", (exitCode) => {
      done({
        ok: exitCode === 0,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText(stderr),
        exitCode,
        errorCode: null
      });
    });

    timer = setTimeout(() => {
      child.kill();
      done({
        ok: false,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText(`${stderr}\nTimed out after ${timeoutMs}ms.`),
        exitCode: null,
        errorCode: "ETIMEOUT"
      });
    }, timeoutMs);
  });
}

function getTaskkillExecutable() {
  const systemRoot =
    (typeof process.env.SystemRoot === "string" && process.env.SystemRoot.trim()) ||
    (typeof process.env.WINDIR === "string" && process.env.WINDIR.trim()) ||
    "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "taskkill.exe");
  if (existsSync(candidate)) {
    return candidate;
  }
  return "taskkill";
}

function getRunningProcessRecord(requestId) {
  if (typeof requestId !== "string") {
    return null;
  }
  const record = runningProcesses.get(requestId);
  if (!record || typeof record !== "object" || !record.child) {
    return null;
  }
  return record;
}

async function terminateRunningChild(record) {
  if (!record || !record.child) {
    return false;
  }

  const child = record.child;
  const pid = Number.isInteger(child.pid) ? child.pid : null;

  if (process.platform === "win32" && pid) {
    const taskkillResult = await runCommandCapture(
      getTaskkillExecutable(),
      ["/PID", String(pid), "/T", "/F"],
      { timeoutMs: 9000 }
    );
    if (taskkillResult.ok) {
      return true;
    }
  }

  try {
    if (!child.killed) {
      child.kill();
    }
    return true;
  } catch {
    return false;
  }
}

function emptyRateLimitStatus() {
  return {
    planType: "",
    limitId: "",
    limitName: "",
    rateLimitPrimaryUsedPercent: null,
    rateLimitSecondaryUsedPercent: null,
    rateLimitPrimaryWindowMinutes: null,
    rateLimitSecondaryWindowMinutes: null,
    creditsBalance: "",
    creditsHasCredits: null,
    creditsUnlimited: null
  };
}

function normalizePlanTypeLabel(planType) {
  const key = typeof planType === "string" ? planType.trim().toLowerCase() : "";
  if (!key) {
    return "";
  }
  const labels = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    unknown: "Unknown"
  };
  return labels[key] || key;
}

function pickRateLimitSnapshot(rateLimitResult) {
  if (!rateLimitResult || typeof rateLimitResult !== "object") {
    return null;
  }

  const byLimitId =
    rateLimitResult.rateLimitsByLimitId && typeof rateLimitResult.rateLimitsByLimitId === "object"
      ? rateLimitResult.rateLimitsByLimitId
      : null;

  if (byLimitId) {
    if (byLimitId.codex && typeof byLimitId.codex === "object") {
      return byLimitId.codex;
    }
    for (const snapshot of Object.values(byLimitId)) {
      if (snapshot && typeof snapshot === "object") {
        return snapshot;
      }
    }
  }

  if (rateLimitResult.rateLimits && typeof rateLimitResult.rateLimits === "object") {
    return rateLimitResult.rateLimits;
  }

  return null;
}

function normalizeRateLimitSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const primary = snapshot.primary && typeof snapshot.primary === "object" ? snapshot.primary : null;
  const secondary = snapshot.secondary && typeof snapshot.secondary === "object" ? snapshot.secondary : null;
  const credits = snapshot.credits && typeof snapshot.credits === "object" ? snapshot.credits : null;

  const normalized = {
    planType: typeof snapshot.planType === "string" ? snapshot.planType : "",
    limitId: typeof snapshot.limitId === "string" ? snapshot.limitId : "",
    limitName: typeof snapshot.limitName === "string" ? snapshot.limitName : "",
    rateLimitPrimaryUsedPercent: parseIntegerLike(primary ? primary.usedPercent ?? primary.used_percent : null),
    rateLimitSecondaryUsedPercent: parseIntegerLike(
      secondary ? secondary.usedPercent ?? secondary.used_percent : null
    ),
    rateLimitPrimaryWindowMinutes: parseIntegerLike(
      primary ? primary.windowDurationMins ?? primary.window_minutes : null
    ),
    rateLimitSecondaryWindowMinutes: parseIntegerLike(
      secondary ? secondary.windowDurationMins ?? secondary.window_minutes : null
    ),
    creditsBalance:
      credits && typeof credits.balance === "string" && credits.balance.trim() ? credits.balance.trim() : "",
    creditsHasCredits: credits && typeof credits.hasCredits === "boolean" ? credits.hasCredits : null,
    creditsUnlimited: credits && typeof credits.unlimited === "boolean" ? credits.unlimited : null
  };

  const hasAnyValue =
    normalized.planType ||
    normalized.limitId ||
    normalized.limitName ||
    Number.isInteger(normalized.rateLimitPrimaryUsedPercent) ||
    Number.isInteger(normalized.rateLimitSecondaryUsedPercent) ||
    Number.isInteger(normalized.rateLimitPrimaryWindowMinutes) ||
    Number.isInteger(normalized.rateLimitSecondaryWindowMinutes) ||
    normalized.creditsBalance ||
    typeof normalized.creditsHasCredits === "boolean" ||
    typeof normalized.creditsUnlimited === "boolean";

  return hasAnyValue ? normalized : null;
}

function summarizeRateLimitStatus(rateLimitInfo) {
  if (!rateLimitInfo || typeof rateLimitInfo !== "object") {
    return "";
  }

  if (rateLimitInfo.creditsUnlimited === true) {
    return "Credits: unlimited";
  }
  if (rateLimitInfo.creditsBalance) {
    return `Credits: ${rateLimitInfo.creditsBalance}`;
  }

  if (Number.isInteger(rateLimitInfo.rateLimitPrimaryUsedPercent)) {
    const left = Math.max(0, Math.min(100, 100 - rateLimitInfo.rateLimitPrimaryUsedPercent));
    if (Number.isInteger(rateLimitInfo.rateLimitPrimaryWindowMinutes)) {
      return `Primary usage ${left}% left (${rateLimitInfo.rateLimitPrimaryWindowMinutes}m window)`;
    }
    return `Primary usage ${left}% left`;
  }

  if (Number.isInteger(rateLimitInfo.rateLimitSecondaryUsedPercent)) {
    const left = Math.max(0, Math.min(100, 100 - rateLimitInfo.rateLimitSecondaryUsedPercent));
    if (Number.isInteger(rateLimitInfo.rateLimitSecondaryWindowMinutes)) {
      return `Secondary usage ${left}% left (${rateLimitInfo.rateLimitSecondaryWindowMinutes}m window)`;
    }
    return `Secondary usage ${left}% left`;
  }

  return "";
}

function buildAccountInfoFromAppServer(accountResult) {
  const result = accountResult && typeof accountResult === "object" ? accountResult : null;
  const account = result && result.account && typeof result.account === "object" ? result.account : null;
  const requiresOpenaiAuth = Boolean(result && result.requiresOpenaiAuth);

  if (!account) {
    if (requiresOpenaiAuth) {
      return {
        loggedIn: false,
        authMode: "none",
        accountLabel: "Not signed in",
        providerLabel: "",
        planType: ""
      };
    }
    return {
      loggedIn: null,
      authMode: "unknown",
      accountLabel: "Unknown",
      providerLabel: "",
      planType: ""
    };
  }

  const type = typeof account.type === "string" ? account.type.trim().toLowerCase() : "";
  if (type === "chatgpt") {
    const email = typeof account.email === "string" ? account.email.trim() : "";
    const planType = typeof account.planType === "string" ? account.planType.trim() : "";
    return {
      loggedIn: true,
      authMode: "chatgpt",
      accountLabel: email || "ChatGPT",
      providerLabel: "ChatGPT",
      planType
    };
  }

  if (type === "apikey") {
    return {
      loggedIn: true,
      authMode: "api-key",
      accountLabel: "API key",
      providerLabel: "API key",
      planType: ""
    };
  }

  return {
    loggedIn: true,
    authMode: type || "unknown",
    accountLabel: "Signed in",
    providerLabel: "",
    planType: ""
  };
}

function probeCodexAppServerStatus(spec, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 16000;
  const args = [...spec.commandArgs, "app-server"];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let rpcErrors = "";
    let finished = false;
    let timer = null;
    let accountResult = null;
    let rateLimitsResult = null;
    let gotAccount = false;
    let gotRateLimits = false;
    let initialized = false;

    const done = (result) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(spec.command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      env: getCommandEnvironment(),
      shell: shouldUseShell(spec.command)
    });

    const send = (message) => {
      if (!message || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // no-op
      }
    };

    const maybeFinish = () => {
      if (!gotAccount || !gotRateLimits) {
        return;
      }
      done({
        ok: true,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText([stderr, rpcErrors].filter(Boolean).join("\n")),
        exitCode: null,
        errorCode: null,
        accountResult,
        rateLimitsResult
      });
      child.kill();
    };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      stdout += `${trimmed}\n`;

      let message = null;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (!message || typeof message !== "object") {
        return;
      }

      if (message.error && typeof message.error === "object") {
        const errorCode = parseIntegerLike(message.error.code);
        const errorMessage =
          typeof message.error.message === "string" ? message.error.message : "Unknown app-server error";
        rpcErrors += `RPC error${Number.isInteger(errorCode) ? ` ${errorCode}` : ""}: ${errorMessage}\n`;
      }

      const responseId = parseIntegerLike(message.id);
      if (responseId === 1) {
        if (message.error) {
          done({
            ok: false,
            stdout: cleanOutputText(stdout),
            stderr: cleanOutputText([stderr, rpcErrors].filter(Boolean).join("\n")),
            exitCode: null,
            errorCode: "ERPC_INIT",
            accountResult: null,
            rateLimitsResult: null
          });
          child.kill();
          return;
        }
        if (!initialized) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: true } });
          send({ jsonrpc: "2.0", id: 3, method: "account/rateLimits/read", params: null });
        }
        return;
      }

      if (responseId === 2) {
        gotAccount = true;
        accountResult = message.result && typeof message.result === "object" ? message.result : null;
        maybeFinish();
        return;
      }

      if (responseId === 3) {
        gotRateLimits = true;
        rateLimitsResult = message.result && typeof message.result === "object" ? message.result : null;
        maybeFinish();
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      done({
        ok: false,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText([stderr, error && error.message ? error.message : ""].join("\n")),
        exitCode: null,
        errorCode: error && error.code ? error.code : null,
        accountResult: null,
        rateLimitsResult: null
      });
    });

    child.on("close", (exitCode) => {
      if (finished) {
        return;
      }
      const cleanedStdout = cleanOutputText(stdout);
      const cleanedStderr = cleanOutputText([stderr, rpcErrors].filter(Boolean).join("\n"));
      done({
        ok: false,
        stdout: cleanedStdout,
        stderr:
          cleanedStderr ||
          `Codex app-server exited${Number.isInteger(exitCode) ? ` with exit code ${exitCode}` : ""}.`,
        exitCode,
        errorCode: null,
        accountResult,
        rateLimitsResult
      });
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-desktop",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null
        }
      }
    });

    timer = setTimeout(() => {
      child.kill();
      done({
        ok: false,
        stdout: cleanOutputText(stdout),
        stderr: cleanOutputText(
          [stderr, rpcErrors, `Timed out after ${timeoutMs}ms while querying app-server.`].join("\n")
        ),
        exitCode: null,
        errorCode: "ETIMEOUT",
        accountResult,
        rateLimitsResult
      });
    }, timeoutMs);
  });
}

async function getCodexStatus(payload) {
  const spec = parseCommandSpec(payload && typeof payload.codexCommand === "string" ? payload.codexCommand : "codex");
  const rateLimitDefaults = emptyRateLimitStatus();

  const versionResult = await runCommandCapture(spec.command, [...spec.commandArgs, "--version"], {
    timeoutMs: 12000
  });

  if (versionResult.errorCode === "ENOENT") {
    return {
      command: spec.command,
      installed: false,
      loggedIn: false,
      authMode: "none",
      accountLabel: "Not signed in",
      providerLabel: "",
      version: "",
      statusText: "Codex command not found.",
      installHint: "Install Codex CLI, run codex login, then click Refresh Status.",
      loginHint: "",
      ...rateLimitDefaults
    };
  }

  const versionOutput = versionResult.stdout || versionResult.stderr;
  const version = versionOutput.split("\n")[0] || "";

  if (!versionResult.ok && !versionOutput) {
    return {
      command: spec.command,
      installed: false,
      loggedIn: false,
      authMode: "none",
      accountLabel: "Not signed in",
      providerLabel: "",
      version: "",
      statusText: versionResult.stderr || "Unable to run the Codex command.",
      installHint: "Set a valid Codex command and click Refresh Status.",
      loginHint: "",
      ...rateLimitDefaults
    };
  }

  const appServerResult = await probeCodexAppServerStatus(spec, { timeoutMs: 16000 });
  if (appServerResult.ok) {
    const accountInfo = buildAccountInfoFromAppServer(appServerResult.accountResult);
    const rateLimitSnapshot = pickRateLimitSnapshot(appServerResult.rateLimitsResult);
    const normalizedRateLimitInfo = normalizeRateLimitSnapshot(rateLimitSnapshot);
    const rateLimitInfo = normalizedRateLimitInfo || rateLimitDefaults;
    const planLabel = normalizePlanTypeLabel(rateLimitInfo.planType || accountInfo.planType);

    const statusParts = [];
    if (accountInfo.loggedIn === false) {
      statusParts.push("Not signed in.");
    } else if (accountInfo.accountLabel && accountInfo.accountLabel !== "Unknown") {
      statusParts.push(`Signed in as ${accountInfo.accountLabel}`);
    }
    if (planLabel) {
      statusParts.push(`Plan: ${planLabel}`);
    }

    const usageStatus = summarizeRateLimitStatus(rateLimitInfo);
    if (usageStatus) {
      statusParts.push(usageStatus);
    }

    return {
      command: spec.command,
      installed: true,
      loggedIn: accountInfo.loggedIn,
      authMode: accountInfo.authMode,
      accountLabel: accountInfo.accountLabel,
      providerLabel: accountInfo.providerLabel,
      version,
      statusText: statusParts.join(" | ") || "Codex CLI is installed.",
      installHint: "",
      loginHint: accountInfo.loggedIn === false ? "Run codex login in terminal, then click Refresh Status." : "",
      ...rateLimitInfo,
      planType: rateLimitInfo.planType || accountInfo.planType || ""
    };
  }

  const loginResult = await runCommandCapture(spec.command, [...spec.commandArgs, "login", "status"], {
    timeoutMs: 15000
  });
  const loginOutput = [loginResult.stdout, loginResult.stderr].filter(Boolean).join("\n").trim();
  const accountInfo = detectAccountInfo(loginOutput);

  let loggedIn = null;
  if (/not logged in/i.test(loginOutput)) {
    loggedIn = false;
  } else if (/logged in/i.test(loginOutput)) {
    loggedIn = true;
  } else if (loginResult.ok) {
    loggedIn = true;
  }

  return {
    command: spec.command,
    installed: true,
    loggedIn,
    authMode: accountInfo.authMode,
    accountLabel: accountInfo.accountLabel,
    providerLabel: accountInfo.providerLabel,
    version,
    statusText: loginOutput || "Codex CLI is installed.",
    installHint: "",
    loginHint: loggedIn === false ? "Run codex login in terminal, then click Refresh Status." : "",
    ...rateLimitDefaults
  };
}

function extensionForMime(mime) {
  if (typeof mime !== "string") {
    return "png";
  }
  const normalized = mime.toLowerCase().trim();
  if (normalized === "image/jpeg") {
    return "jpg";
  }
  if (normalized === "image/png") {
    return "png";
  }
  if (normalized === "image/webp") {
    return "webp";
  }
  if (normalized === "image/gif") {
    return "gif";
  }
  if (normalized === "image/bmp") {
    return "bmp";
  }
  if (normalized === "image/tiff") {
    return "tiff";
  }
  return "png";
}

function parseDataUrlImage(input) {
  if (typeof input !== "string") {
    return null;
  }
  const match = input.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

async function savePastedImageData(dataUrl) {
  const parsed = parseDataUrlImage(dataUrl);
  if (!parsed || !parsed.buffer || !parsed.buffer.length) {
    throw new Error("Invalid clipboard image payload.");
  }

  const imagesDir = path.join(app.getPath("userData"), PASTED_IMAGES_DIRNAME);
  await fs.mkdir(imagesDir, { recursive: true });

  const fileName = `paste-${Date.now()}-${Math.random().toString(16).slice(2)}.${extensionForMime(
    parsed.mimeType
  )}`;
  const filePath = path.join(imagesDir, fileName);
  await fs.writeFile(filePath, parsed.buffer);
  return filePath;
}

async function listFolderPreview(rootDir) {
  const results = [];
  const queue = [{ absPath: rootDir, relPath: "", depth: 0 }];

  while (queue.length > 0 && results.length < MAX_FOLDER_ITEMS) {
    const current = queue.shift();
    let entries = [];

    try {
      entries = await fs.readdir(current.absPath, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (results.length >= MAX_FOLDER_ITEMS) {
        break;
      }

      const relPath = current.relPath ? path.join(current.relPath, entry.name) : entry.name;
      results.push({
        name: entry.name,
        relPath,
        isDirectory: entry.isDirectory(),
        depth: current.depth
      });

      if (entry.isDirectory() && current.depth < MAX_FOLDER_DEPTH) {
        queue.push({
          absPath: path.join(current.absPath, entry.name),
          relPath,
          depth: current.depth + 1
        });
      }
    }
  }

  return results;
}

function clampWorkspacePreviewLine(line) {
  const text = typeof line === "string" ? line.replace(/\r/g, "") : "";
  if (text.length <= MAX_WORKSPACE_PREVIEW_LINE_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_WORKSPACE_PREVIEW_LINE_LENGTH - 1)}…`;
}

function isUnknownHeadError(stderrText) {
  const text = typeof stderrText === "string" ? stderrText.toLowerCase() : "";
  if (!text) {
    return false;
  }
  return (
    text.includes("unknown revision or path not in the working tree") ||
    text.includes("bad revision 'head'") ||
    text.includes("ambiguous argument 'head'")
  );
}

function parseGitPathFromStatusLine(pathText) {
  const raw = typeof pathText === "string" ? pathText.trim() : "";
  if (!raw) {
    return "";
  }

  const renameArrow = raw.lastIndexOf(" -> ");
  const renamed = renameArrow >= 0 ? raw.slice(renameArrow + 4).trim() : raw;
  if (!renamed) {
    return "";
  }

  if (renamed.startsWith('"') && renamed.endsWith('"') && renamed.length >= 2) {
    return renamed.slice(1, -1).replace(/\\"/g, '"');
  }
  return renamed;
}

function parseGitStatusEntries(stdoutText) {
  const text = typeof stdoutText === "string" ? stdoutText : "";
  const lines = text.split(/\r?\n/g);
  const items = [];

  for (const line of lines) {
    if (!line || line.length < 4) {
      continue;
    }
    const status = line.slice(0, 2);
    const filePath = parseGitPathFromStatusLine(line.slice(3));
    if (!filePath) {
      continue;
    }
    items.push({
      path: filePath,
      status
    });
  }

  return items;
}

function parseGitNumstat(stdoutText) {
  const text = typeof stdoutText === "string" ? stdoutText : "";
  const lines = text.split(/\r?\n/g);
  const byPath = new Map();

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }

    const pathText = parts.slice(2).join("\t").trim();
    if (!pathText) {
      continue;
    }

    const additions = /^\d+$/.test(parts[0]) ? Number.parseInt(parts[0], 10) : null;
    const deletions = /^\d+$/.test(parts[1]) ? Number.parseInt(parts[1], 10) : null;
    const isBinary = parts[0] === "-" || parts[1] === "-";
    byPath.set(pathText, {
      path: pathText,
      additions,
      deletions,
      isBinary
    });
  }

  return byPath;
}

function buildPreviewFromDiff(diffText) {
  const lines = typeof diffText === "string" ? diffText.split(/\r?\n/g) : [];
  const preview = [];
  let truncated = false;

  for (const line of lines) {
    if (preview.length >= MAX_WORKSPACE_DIFF_PREVIEW_LINES) {
      truncated = true;
      break;
    }

    if (!line.trim()) {
      continue;
    }
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      continue;
    }

    if (line.startsWith("@@")) {
      preview.push({
        type: "hunk",
        text: clampWorkspacePreviewLine(line)
      });
      continue;
    }
    if (line.startsWith("+")) {
      preview.push({
        type: "add",
        text: clampWorkspacePreviewLine(line)
      });
      continue;
    }
    if (line.startsWith("-")) {
      preview.push({
        type: "del",
        text: clampWorkspacePreviewLine(line)
      });
      continue;
    }
    if (line.startsWith(" ")) {
      preview.push({
        type: "ctx",
        text: clampWorkspacePreviewLine(line)
      });
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      preview.push({
        type: "meta",
        text: clampWorkspacePreviewLine(line)
      });
    }
  }

  return {
    preview,
    truncated
  };
}

function isPathWithinRoot(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readWorkspaceFileContent(workspaceDir, relPath) {
  const safeWorkspaceDir = typeof workspaceDir === "string" ? workspaceDir.trim() : "";
  const safeRelPath = typeof relPath === "string" ? relPath.trim() : "";

  if (!safeWorkspaceDir || !safeRelPath) {
    return {
      ok: false,
      path: normalizeRelPathForUi(safeRelPath),
      message: "Missing workspace path or file path.",
      text: "",
      truncated: false
    };
  }

  const rootPath = path.resolve(safeWorkspaceDir);
  const targetPath = path.resolve(rootPath, safeRelPath);
  if (!isPathWithinRoot(rootPath, targetPath)) {
    return {
      ok: false,
      path: normalizeRelPathForUi(safeRelPath),
      message: "File path is outside the selected workspace.",
      text: "",
      truncated: false
    };
  }

  let stat = null;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    return {
      ok: false,
      path: normalizeRelPathForUi(safeRelPath),
      message: "File not found (it may have been deleted).",
      text: "",
      truncated: false
    };
  }

  if (!stat || !stat.isFile()) {
    return {
      ok: false,
      path: normalizeRelPathForUi(safeRelPath),
      message: "Selected path is not a file.",
      text: "",
      truncated: false
    };
  }

  let text = "";
  let truncated = false;
  if (stat.size > MAX_WORKSPACE_CODE_VIEW_BYTES) {
    let fileHandle = null;
    try {
      fileHandle = await fs.open(targetPath, "r");
      const buffer = Buffer.allocUnsafe(MAX_WORKSPACE_CODE_VIEW_BYTES);
      const readResult = await fileHandle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, readResult.bytesRead).toString("utf8");
      truncated = true;
    } catch {
      return {
        ok: false,
        path: normalizeRelPathForUi(safeRelPath),
        message: "Failed to read file.",
        text: "",
        truncated: false
      };
    } finally {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {
          // no-op
        }
      }
    }
  } else {
    try {
      text = await fs.readFile(targetPath, "utf8");
    } catch {
      return {
        ok: false,
        path: normalizeRelPathForUi(safeRelPath),
        message: "Failed to read file.",
        text: "",
        truncated: false
      };
    }
  }

  if (text.includes("\u0000")) {
    return {
      ok: false,
      path: normalizeRelPathForUi(safeRelPath),
      message: "Binary file preview is not supported.",
      text: "",
      truncated: false
    };
  }

  return {
    ok: true,
    path: normalizeRelPathForUi(safeRelPath),
    message: "",
    text: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    truncated
  };
}

async function buildUntrackedFilePreview(workspaceDir, relPath) {
  const absolutePath = path.resolve(workspaceDir, relPath);
  if (!isPathWithinRoot(workspaceDir, absolutePath)) {
    return [
      {
        type: "meta",
        text: "(Unable to preview file: path outside workspace.)"
      }
    ];
  }

  try {
    const content = await fs.readFile(absolutePath, "utf8");
    if (content.includes("\u0000")) {
      return [
        {
          type: "meta",
          text: "(Binary file. Text preview unavailable.)"
        }
      ];
    }
    const lines = content.split(/\r?\n/g).slice(0, MAX_UNTRACKED_FILE_PREVIEW_LINES);
    if (!lines.length) {
      return [
        {
          type: "meta",
          text: "(Empty file.)"
        }
      ];
    }
    return lines.map((line) => ({
      type: "add",
      text: clampWorkspacePreviewLine(`+${line}`)
    }));
  } catch {
    return [
      {
        type: "meta",
        text: "(Unable to read file preview.)"
      }
    ];
  }
}

async function readDiffTextForFile(workspaceDir, relPath) {
  const baseArgs = ["-C", workspaceDir, "diff", "--no-ext-diff", "--unified=1", "--no-color"];
  let diffResult = await runCommandCapture("git", [...baseArgs, "HEAD", "--", relPath], {
    cwd: workspaceDir,
    timeoutMs: 12000
  });
  if (!diffResult.ok && isUnknownHeadError(diffResult.stderr)) {
    diffResult = await runCommandCapture("git", [...baseArgs, "--", relPath], {
      cwd: workspaceDir,
      timeoutMs: 12000
    });
  }

  const text = [diffResult.stdout, diffResult.stderr]
    .filter((chunk) => typeof chunk === "string" && chunk.trim())
    .join("\n")
    .trim();

  if (text) {
    return text;
  }

  const cachedArgs = ["-C", workspaceDir, "diff", "--cached", "--no-ext-diff", "--unified=1", "--no-color", "--", relPath];
  const cachedResult = await runCommandCapture("git", cachedArgs, {
    cwd: workspaceDir,
    timeoutMs: 12000
  });

  return [cachedResult.stdout, cachedResult.stderr]
    .filter((chunk) => typeof chunk === "string" && chunk.trim())
    .join("\n")
    .trim();
}

function resolveStatsForPath(statsByPath, filePath) {
  if (statsByPath.has(filePath)) {
    return statsByPath.get(filePath);
  }

  for (const [candidatePath, stats] of statsByPath.entries()) {
    if (candidatePath.includes("=>") && candidatePath.endsWith(filePath)) {
      return stats;
    }
  }

  return null;
}

function normalizeWorkspaceCacheKey(workspaceDir) {
  const resolved = path.resolve(workspaceDir);
  if (process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

function normalizeRelPathForUi(relPath) {
  return typeof relPath === "string" ? relPath.replace(/\\/g, "/") : "";
}

function shouldSkipWorkspaceDir(name) {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  return NON_GIT_SKIP_DIRS.has(key);
}

function shouldTrackNonGitTextFile(relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    return false;
  }
  const normalized = normalizeRelPathForUi(relPath);
  const baseName = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(baseName).toLowerCase();
  if (NON_GIT_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }
  return baseName === "dockerfile" || baseName === "makefile" || baseName === "justfile" || baseName === "readme";
}

function splitLinesNormalized(text) {
  if (typeof text !== "string" || !text.length) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function findLineInWindow(lines, needle, startIndex, lookahead) {
  if (!Array.isArray(lines) || typeof needle !== "string") {
    return -1;
  }
  const start = Math.max(0, startIndex);
  const end = Math.min(lines.length - 1, start + Math.max(1, lookahead) - 1);
  for (let i = start; i <= end; i += 1) {
    if (lines[i] === needle) {
      return i;
    }
  }
  return -1;
}

function buildMetaPreview(text) {
  return [
    {
      type: "meta",
      text: clampWorkspacePreviewLine(text)
    }
  ];
}

function buildAddDeletePreviewFromText(text, kind) {
  const lines = splitLinesNormalized(text);
  if (!lines.length) {
    return {
      preview: buildMetaPreview("(Empty file.)"),
      count: 0,
      truncated: false
    };
  }

  const type = kind === "del" ? "del" : "add";
  const prefix = type === "del" ? "-" : "+";
  const preview = [];
  let truncated = false;

  for (const line of lines) {
    if (preview.length >= MAX_WORKSPACE_DIFF_PREVIEW_LINES) {
      truncated = true;
      break;
    }
    preview.push({
      type,
      text: clampWorkspacePreviewLine(`${prefix}${line}`)
    });
  }

  return {
    preview,
    count: lines.length,
    truncated
  };
}

function buildTextDiffPreview(beforeText, afterText) {
  const beforeLines = splitLinesNormalized(beforeText);
  const afterLines = splitLinesNormalized(afterText);

  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  const preview = [];
  let truncated = false;

  const pushPreviewLine = (type, prefix, lineText) => {
    if (preview.length >= MAX_WORKSPACE_DIFF_PREVIEW_LINES) {
      truncated = true;
      return false;
    }
    preview.push({
      type,
      text: clampWorkspacePreviewLine(`${prefix}${lineText}`)
    });
    return true;
  };

  while (i < beforeLines.length || j < afterLines.length) {
    if (preview.length >= MAX_WORKSPACE_DIFF_PREVIEW_LINES) {
      truncated = true;
      break;
    }

    const beforeLine = i < beforeLines.length ? beforeLines[i] : null;
    const afterLine = j < afterLines.length ? afterLines[j] : null;

    if (beforeLine !== null && afterLine !== null && beforeLine === afterLine) {
      i += 1;
      j += 1;
      continue;
    }

    if (beforeLine === null && afterLine !== null) {
      additions += 1;
      if (!pushPreviewLine("add", "+", afterLine)) {
        break;
      }
      j += 1;
      continue;
    }

    if (afterLine === null && beforeLine !== null) {
      deletions += 1;
      if (!pushPreviewLine("del", "-", beforeLine)) {
        break;
      }
      i += 1;
      continue;
    }

    const matchInAfter = findLineInWindow(
      afterLines,
      beforeLine,
      j + 1,
      MAX_NON_GIT_LOOKAHEAD_LINES
    );
    const matchInBefore = findLineInWindow(
      beforeLines,
      afterLine,
      i + 1,
      MAX_NON_GIT_LOOKAHEAD_LINES
    );

    if (matchInAfter !== -1 && (matchInBefore === -1 || matchInAfter - j <= matchInBefore - i)) {
      while (j < matchInAfter) {
        additions += 1;
        if (!pushPreviewLine("add", "+", afterLines[j])) {
          break;
        }
        j += 1;
      }
      continue;
    }

    if (matchInBefore !== -1) {
      while (i < matchInBefore) {
        deletions += 1;
        if (!pushPreviewLine("del", "-", beforeLines[i])) {
          break;
        }
        i += 1;
      }
      continue;
    }

    deletions += 1;
    additions += 1;
    if (!pushPreviewLine("del", "-", beforeLine)) {
      break;
    }
    if (!pushPreviewLine("add", "+", afterLine)) {
      break;
    }
    i += 1;
    j += 1;
  }

  if (!preview.length && beforeText !== afterText) {
    preview.push({
      type: "meta",
      text: "(File changed, but no text diff preview is available.)"
    });
  }

  return {
    preview,
    additions,
    deletions,
    truncated
  };
}

async function buildWorkspaceSnapshot(workspaceDir) {
  const rootPath = path.resolve(workspaceDir);
  const queue = [{ absPath: rootPath, relPath: "", depth: 0 }];
  const files = new Map();

  while (queue.length > 0 && files.size < MAX_NON_GIT_TRACKED_FILES) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current.absPath, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (files.size >= MAX_NON_GIT_TRACKED_FILES) {
        break;
      }

      const relPath = current.relPath ? path.join(current.relPath, entry.name) : entry.name;
      const normalizedRelPath = normalizeRelPathForUi(relPath);
      const absPath = path.join(current.absPath, entry.name);

      if (entry.isDirectory()) {
        if (current.depth >= MAX_NON_GIT_TRACK_DEPTH) {
          continue;
        }
        if (shouldSkipWorkspaceDir(entry.name)) {
          continue;
        }
        queue.push({
          absPath,
          relPath,
          depth: current.depth + 1
        });
        continue;
      }

      if (!entry.isFile() || !shouldTrackNonGitTextFile(normalizedRelPath)) {
        continue;
      }

      let stat = null;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (!stat || !stat.isFile()) {
        continue;
      }

      const item = {
        path: normalizedRelPath,
        mtimeMs: Math.floor(stat.mtimeMs || 0),
        size: Number.isFinite(stat.size) ? stat.size : 0,
        text: null,
        tooLarge: false,
        binary: false
      };

      if (item.size > MAX_NON_GIT_FILE_BYTES) {
        item.tooLarge = true;
        files.set(item.path, item);
        continue;
      }

      try {
        const text = await fs.readFile(absPath, "utf8");
        if (text.includes("\u0000")) {
          item.binary = true;
        } else {
          item.text = text;
        }
      } catch {
        item.binary = true;
      }

      files.set(item.path, item);
    }
  }

  return {
    rootPath,
    capturedAt: Date.now(),
    files
  };
}

function scoreChange(item) {
  const additions = Number.isInteger(item.additions) ? item.additions : 0;
  const deletions = Number.isInteger(item.deletions) ? item.deletions : 0;
  return additions + deletions;
}

function compareSnapshotItems(previousItem, nextItem) {
  if (!previousItem || !nextItem) {
    return true;
  }
  if (previousItem.size !== nextItem.size) {
    return true;
  }
  if (previousItem.mtimeMs !== nextItem.mtimeMs) {
    return true;
  }
  if (previousItem.text !== nextItem.text) {
    return true;
  }
  if (previousItem.binary !== nextItem.binary || previousItem.tooLarge !== nextItem.tooLarge) {
    return true;
  }
  return false;
}

async function listWorkspaceChangesWithoutGit(workspaceDir) {
  const cacheKey = normalizeWorkspaceCacheKey(workspaceDir);
  const previousSnapshot = workspaceSnapshotCache.get(cacheKey) || null;
  const nextSnapshot = await buildWorkspaceSnapshot(workspaceDir);

  if (!previousSnapshot) {
    const seedFiles = [];
    let seedAdditions = 0;

    const recentFiles = Array.from(nextSnapshot.files.values())
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_WORKSPACE_CHANGE_FILES);

    for (const item of recentFiles) {
      let preview = [];
      let additions = null;
      let deletions = 0;
      let truncated = false;
      if (typeof item.text === "string") {
        const result = buildAddDeletePreviewFromText(item.text, "add");
        preview = result.preview;
        additions = result.count;
        truncated = result.truncated;
      } else if (item.binary) {
        preview = buildMetaPreview("(Binary file. Text preview unavailable.)");
      } else if (item.tooLarge) {
        preview = buildMetaPreview("(Large file. Preview unavailable.)");
      } else {
        preview = buildMetaPreview("(File detected.)");
      }

      if (Number.isInteger(additions)) {
        seedAdditions += additions;
      }

      seedFiles.push({
        path: item.path,
        status: "??",
        additions,
        deletions,
        isBinary: Boolean(item.binary),
        preview,
        truncated
      });
    }

    workspaceSnapshotCache.set(cacheKey, nextSnapshot);
    return {
      ok: true,
      available: true,
      reason: "non-git-initialized",
      message: seedFiles.length
        ? "Selected folder is not a git repository. Showing recent files and tracking future changes."
        : "Tracking file changes (folder is not a git repository).",
      totals: { additions: seedAdditions, deletions: 0 },
      files: seedFiles
    };
  }

  const changedPaths = new Set();
  for (const filePath of previousSnapshot.files.keys()) {
    if (!nextSnapshot.files.has(filePath) || compareSnapshotItems(previousSnapshot.files.get(filePath), nextSnapshot.files.get(filePath))) {
      changedPaths.add(filePath);
    }
  }
  for (const filePath of nextSnapshot.files.keys()) {
    if (!previousSnapshot.files.has(filePath) || compareSnapshotItems(previousSnapshot.files.get(filePath), nextSnapshot.files.get(filePath))) {
      changedPaths.add(filePath);
    }
  }

  const changes = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const filePath of changedPaths) {
    const previousItem = previousSnapshot.files.get(filePath) || null;
    const nextItem = nextSnapshot.files.get(filePath) || null;

    let preview = [];
    let additions = null;
    let deletions = null;
    let truncated = false;
    let status = " M";

    if (!previousItem && nextItem) {
      status = "??";
      if (typeof nextItem.text === "string") {
        const result = buildAddDeletePreviewFromText(nextItem.text, "add");
        preview = result.preview;
        additions = result.count;
        deletions = 0;
        truncated = result.truncated;
      } else if (nextItem.binary) {
        preview = buildMetaPreview("(New binary file. Text preview unavailable.)");
      } else if (nextItem.tooLarge) {
        preview = buildMetaPreview("(New file is large. Preview unavailable.)");
      } else {
        preview = buildMetaPreview("(New file added.)");
      }
    } else if (previousItem && !nextItem) {
      status = " D";
      if (typeof previousItem.text === "string") {
        const result = buildAddDeletePreviewFromText(previousItem.text, "del");
        preview = result.preview;
        additions = 0;
        deletions = result.count;
        truncated = result.truncated;
      } else {
        preview = buildMetaPreview("(File deleted.)");
      }
    } else if (previousItem && nextItem) {
      status = " M";
      if (typeof previousItem.text === "string" && typeof nextItem.text === "string") {
        const result = buildTextDiffPreview(previousItem.text, nextItem.text);
        preview = result.preview;
        additions = result.additions;
        deletions = result.deletions;
        truncated = result.truncated;
      } else if (nextItem.binary || previousItem.binary) {
        preview = buildMetaPreview("(Binary file changed. Text preview unavailable.)");
      } else if (nextItem.tooLarge || previousItem.tooLarge) {
        preview = buildMetaPreview("(Large file changed. Preview unavailable.)");
      } else {
        preview = buildMetaPreview("(File changed.)");
      }
    }

    if (!preview.length) {
      preview = buildMetaPreview("(File changed.)");
    }

    if (Number.isInteger(additions)) {
      totalAdditions += additions;
    }
    if (Number.isInteger(deletions)) {
      totalDeletions += deletions;
    }

    changes.push({
      path: filePath,
      status,
      additions,
      deletions,
      isBinary: Boolean((previousItem && previousItem.binary) || (nextItem && nextItem.binary)),
      preview,
      truncated
    });
  }

  changes.sort((a, b) => {
    const scoreDelta = scoreChange(b) - scoreChange(a);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return a.path.localeCompare(b.path);
  });

  const files = changes.slice(0, MAX_WORKSPACE_CHANGE_FILES);
  const message = files.length
    ? "Showing recent file changes (non-git workspace)."
    : "No recent file changes detected (non-git workspace).";

  workspaceSnapshotCache.set(cacheKey, nextSnapshot);
  return {
    ok: true,
    available: true,
    reason: "non-git-tracking",
    message,
    totals: {
      additions: totalAdditions,
      deletions: totalDeletions
    },
    files
  };
}

async function listWorkspaceChanges(workspaceDir) {
  const safeDir = typeof workspaceDir === "string" ? workspaceDir.trim() : "";
  const emptyResult = {
    ok: true,
    available: false,
    reason: "no-workspace",
    message: "No workspace selected.",
    totals: { additions: 0, deletions: 0 },
    files: []
  };

  if (!safeDir) {
    return emptyResult;
  }

  const repoResult = await runCommandCapture("git", ["-C", safeDir, "rev-parse", "--is-inside-work-tree"], {
    cwd: safeDir,
    timeoutMs: 8000
  });
  if (repoResult.errorCode === "ENOENT") {
    const nonGitResult = await listWorkspaceChangesWithoutGit(safeDir);
    return {
      ...nonGitResult,
      reason: "git-missing-fallback",
      message:
        "Git is not installed. Showing recent file changes from workspace snapshots."
    };
  }
  if (!repoResult.ok || !/\btrue\b/i.test(repoResult.stdout)) {
    const nonGitResult = await listWorkspaceChangesWithoutGit(safeDir);
    return {
      ...nonGitResult,
      reason: "not-git-repo",
      message:
        nonGitResult.files && nonGitResult.files.length
          ? "Selected folder is not a git repository. Showing recent file changes."
          : "Selected folder is not a git repository. Tracking file changes from now on."
    };
  }

  const statusResult = await runCommandCapture(
    "git",
    ["-C", safeDir, "status", "--porcelain"],
    {
      cwd: safeDir,
      timeoutMs: 12000
    }
  );
  if (!statusResult.ok) {
    return {
      ok: false,
      available: false,
      reason: "git-status-failed",
      message: statusResult.stderr || "Unable to query git status.",
      totals: { additions: 0, deletions: 0 },
      files: []
    };
  }

  const statusEntries = parseGitStatusEntries(statusResult.stdout);
  if (!statusEntries.length) {
    return {
      ok: true,
      available: true,
      reason: "clean",
      message: "No code changes detected.",
      totals: { additions: 0, deletions: 0 },
      files: []
    };
  }

  let numstatResult = await runCommandCapture(
    "git",
    ["-C", safeDir, "diff", "--numstat", "--no-ext-diff", "HEAD", "--"],
    {
      cwd: safeDir,
      timeoutMs: 12000
    }
  );
  if (!numstatResult.ok && isUnknownHeadError(numstatResult.stderr)) {
    numstatResult = await runCommandCapture(
      "git",
      ["-C", safeDir, "diff", "--numstat", "--no-ext-diff", "--"],
      {
        cwd: safeDir,
        timeoutMs: 12000
      }
    );
  }
  const statsByPath = parseGitNumstat(numstatResult.stdout);

  const candidates = statusEntries.map((entry) => {
    const stats = resolveStatsForPath(statsByPath, entry.path);
    return {
      path: entry.path,
      status: entry.status,
      additions: stats ? stats.additions : null,
      deletions: stats ? stats.deletions : null,
      isBinary: stats ? stats.isBinary : false
    };
  });

  candidates.sort((a, b) => {
    const aScore = (Number.isInteger(a.additions) ? a.additions : 0) + (Number.isInteger(a.deletions) ? a.deletions : 0);
    const bScore = (Number.isInteger(b.additions) ? b.additions : 0) + (Number.isInteger(b.deletions) ? b.deletions : 0);
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    return a.path.localeCompare(b.path);
  });

  const selected = candidates.slice(0, MAX_WORKSPACE_CHANGE_FILES);
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const candidate of selected) {
    if (Number.isInteger(candidate.additions)) {
      totalAdditions += candidate.additions;
    }
    if (Number.isInteger(candidate.deletions)) {
      totalDeletions += candidate.deletions;
    }

    const isUntracked = candidate.status === "??";
    let preview = [];
    let truncated = false;

    if (isUntracked) {
      preview = await buildUntrackedFilePreview(safeDir, candidate.path);
      truncated = preview.length >= MAX_UNTRACKED_FILE_PREVIEW_LINES;
    } else {
      const diffText = await readDiffTextForFile(safeDir, candidate.path);
      const parsed = buildPreviewFromDiff(diffText);
      preview = parsed.preview;
      truncated = parsed.truncated;
      if (!preview.length) {
        preview = [
          {
            type: "meta",
            text: candidate.isBinary
              ? "(Binary file change. Text preview unavailable.)"
              : "(No text diff preview available for this change.)"
          }
        ];
      }
    }

    files.push({
      path: candidate.path,
      status: candidate.status,
      additions: candidate.additions,
      deletions: candidate.deletions,
      isBinary: candidate.isBinary,
      preview,
      truncated
    });
  }

  return {
    ok: true,
    available: true,
    reason: "",
    message: "",
    totals: {
      additions: totalAdditions,
      deletions: totalDeletions
    },
    files
  };
}

ipcMain.handle("app:load-state", async () => {
  return loadState();
});

ipcMain.handle("app:save-state", async (_, nextState) => {
  return saveState(nextState);
});

ipcMain.handle("dialog:pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("dialog:pick-images", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"]
      }
    ]
  });

  if (result.canceled || !result.filePaths.length) {
    return [];
  }
  return result.filePaths;
});

ipcMain.handle("fs:list-folder", async (_, folderPath) => {
  if (typeof folderPath !== "string" || !folderPath.trim()) {
    return [];
  }
  return listFolderPreview(folderPath.trim());
});

ipcMain.handle("fs:read-workspace-file", async (_, payload) => {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  return readWorkspaceFileContent(safePayload.workspaceDir, safePayload.relPath);
});

ipcMain.handle("git:workspace-changes", async (_, workspaceDir) => {
  return listWorkspaceChanges(workspaceDir);
});

ipcMain.handle("codex:status", async (_, payload) => {
  return getCodexStatus(payload || {});
});

ipcMain.handle("codex:send", async (_, payload) => {
  return runCodex(payload || {});
});

ipcMain.handle("codex:cancel", async (_, requestId) => {
  const record = getRunningProcessRecord(requestId);
  if (!record) {
    return false;
  }

  record.cancelRequested = true;
  record.cancelRequestedAt = Date.now();
  const terminated = await terminateRunningChild(record);
  if (!terminated) {
    record.cancelRequested = false;
    record.cancelRequestedAt = 0;
  }
  return terminated;
});

ipcMain.handle("clipboard:save-image", async (_, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.trim()) {
    return null;
  }
  return savePastedImageData(dataUrl);
});

app.whenReady().then(() => {
  createWindow();
});

app.on("before-quit", () => {
  for (const record of runningProcesses.values()) {
    if (!record || !record.child) {
      continue;
    }
    try {
      record.child.kill();
    } catch {
      // no-op
    }
  }
  runningProcesses.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
