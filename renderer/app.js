const MODEL_PROFILES = [
  { value: "codex-5.1", label: "Codex 5.1", model: "gpt-5.1-codex", defaultReasoning: "low" },
  { value: "codex-5.2", label: "Codex 5.2", model: "gpt-5.2-codex", defaultReasoning: "medium" },
  { value: "codex-5.3", label: "Codex 5.3", model: "gpt-5.3-codex", defaultReasoning: "high" }
];
const DEFAULT_MODEL_PROFILE = "codex-5.3";
const PROFILE_BY_VALUE = new Map(MODEL_PROFILES.map((profile) => [profile.value, profile]));
const MODEL_ALIAS_TO_PROFILE = new Map([
  ["gpt-5-codex", "codex-5.3"],
  ["gpt-5.1-codex", "codex-5.1"],
  ["gpt-5.2-codex", "codex-5.2"],
  ["gpt-5.3-codex", "codex-5.3"],
  ["gpt-5", "codex-5.2"],
  ["o3", "codex-5.1"],
  ["o4-mini", "codex-5.1"],
  ["o1", "codex-5.1"]
]);

const REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];
const DEFAULT_REASONING = "medium";

const APPROVAL_OPTIONS = [
  { value: "never", label: "Yes Yes and Allow" },
  { value: "on-failure", label: "Auto Run (On Failure)" },
  { value: "on-request", label: "Ask Me (Yes / No)" },
  { value: "untrusted", label: "No, Suggest Something Else" }
];
const DEFAULT_APPROVAL = "never";

const modelSelect = document.getElementById("modelSelect");
const reasoningSelect = document.getElementById("reasoningSelect");
const approvalSelect = document.getElementById("approvalSelect");
const codexCommandInput = document.getElementById("codexCommandInput");
const refreshStatusBtn = document.getElementById("refreshStatusBtn");
const codexHealthBadge = document.getElementById("codexHealthBadge");
const codexStatusPanel = document.getElementById("codexStatusPanel");
const startupSplash = document.getElementById("startupSplash");
const topThreadTitle = document.getElementById("topThreadTitle");
const topRepoName = document.getElementById("topRepoName");
const workspacePath = document.getElementById("workspacePath");
const changesCount = document.getElementById("changesCount");
const changesMeta = document.getElementById("changesMeta");
const sessionList = document.getElementById("sessionList");
const changesList = document.getElementById("changesList");
const changeCodeViewer = document.getElementById("changeCodeViewer");
const newChatBtn = document.getElementById("newChatBtn");
const openFolderBtn = document.getElementById("openFolderBtn");
const clearFolderBtn = document.getElementById("clearFolderBtn");
const messages = document.getElementById("messages");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const attachImageBtn = document.getElementById("attachImageBtn");
const attachmentList = document.getElementById("attachmentList");
const statusText = document.getElementById("statusText");
const accountIdentity = document.getElementById("accountIdentity");
const tokenUsageSummary = document.getElementById("tokenUsageSummary");
const tokenRemainingSummary = document.getElementById("tokenRemainingSummary");

let state = null;
let pendingImages = [];
let workspaceChanges = [];
let workspaceChangesTotals = { additions: 0, deletions: 0 };
let workspaceChangesMessage = "Select a workspace folder to view git changes.";
let workspaceChangesLoading = false;
let selectedChangePath = "";
let selectedChangeView = {
  path: "",
  loading: false,
  error: "",
  text: "",
  truncated: false
};
let selectedChangeLoadToken = 0;
let activeRequestId = null;
let saveTimer = null;
let codexStatus = null;
let codexStatusLoading = false;
const ASSISTANT_TYPING_SPEED_CHARS_PER_SEC = 90;
const ASSISTANT_TYPING_TICK_MS = 30;
const RUNNING_STATUS_PREFIX = "running codex";
const CODEX_RUN_TIMEOUT_MS = 4 * 60 * 1000;
const RUN_STATUS_TICK_MS = 1000;
const assistantTypingState = new Map();
let assistantTypingTimer = null;
let runStatusTimer = null;
let runStatusStartMs = 0;
let runStatusPrefix = "";

function uid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return Date.now();
}

function trimString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function formatRunElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopRunStatusTimer() {
  if (runStatusTimer !== null) {
    clearInterval(runStatusTimer);
    runStatusTimer = null;
  }
  runStatusStartMs = 0;
  runStatusPrefix = "";
}

function updateRunStatusLabel() {
  if (!runStatusStartMs || !runStatusPrefix) {
    return;
  }
  setStatus(`${runStatusPrefix} ${formatRunElapsed(now() - runStatusStartMs)}`);
}

function startRunStatusTimer(prefix) {
  stopRunStatusTimer();
  runStatusStartMs = now();
  runStatusPrefix = trimString(prefix, "Running Codex...");
  updateRunStatusLabel();
  runStatusTimer = setInterval(updateRunStatusLabel, RUN_STATUS_TICK_MS);
}

function setRunStatusPrefix(prefix) {
  if (runStatusTimer === null || !runStatusStartMs) {
    setStatus(prefix);
    return;
  }
  runStatusPrefix = trimString(prefix, runStatusPrefix || "Running Codex...");
  updateRunStatusLabel();
}

function shouldAnimateAssistantText(message, fullText) {
  if (!message || message.role !== "assistant") {
    return false;
  }
  if (message.pending || message.error) {
    return false;
  }
  return Boolean(fullText);
}

function stopAssistantTypingLoop() {
  if (assistantTypingTimer !== null) {
    clearInterval(assistantTypingTimer);
    assistantTypingTimer = null;
  }
}

function ensureAssistantTypingLoop() {
  if (assistantTypingTimer !== null) {
    return;
  }
  assistantTypingTimer = setInterval(advanceAssistantTypingLoop, ASSISTANT_TYPING_TICK_MS);
}

function primeAssistantTypingState() {
  assistantTypingState.clear();
  if (!state || !Array.isArray(state.sessions)) {
    stopAssistantTypingLoop();
    return;
  }

  const tick = now();
  for (const session of state.sessions) {
    if (!session || !Array.isArray(session.messages)) {
      continue;
    }
    for (const message of session.messages) {
      if (!message || message.role !== "assistant") {
        continue;
      }
      const fullText = typeof message.text === "string" ? message.text : "";
      assistantTypingState.set(message.id, {
        fullText,
        shownLength: fullText.length,
        lastTick: tick
      });
    }
  }
  stopAssistantTypingLoop();
}

function resolveMessageDisplayText(message) {
  const fullText = typeof message.text === "string" ? message.text : "";
  if (!message || message.role !== "assistant") {
    return fullText;
  }

  const tick = now();
  const shouldAnimate = shouldAnimateAssistantText(message, fullText);
  let entry = assistantTypingState.get(message.id);

  if (!entry) {
    entry = {
      fullText,
      shownLength: shouldAnimate ? 0 : fullText.length,
      lastTick: tick
    };
    assistantTypingState.set(message.id, entry);
  }

  if (entry.fullText !== fullText) {
    const previous = trimString(entry.fullText, "").toLowerCase();
    const fromRunningStatus = previous.startsWith(RUNNING_STATUS_PREFIX);
    entry.fullText = fullText;
    entry.shownLength = shouldAnimate
      ? fromRunningStatus
        ? 0
        : Math.min(entry.shownLength, fullText.length)
      : fullText.length;
    entry.lastTick = tick;
  }

  if (!shouldAnimate) {
    entry.shownLength = fullText.length;
    entry.lastTick = tick;
    return fullText;
  }

  if (entry.shownLength < fullText.length) {
    ensureAssistantTypingLoop();
  }

  return fullText.slice(0, entry.shownLength);
}

function isAssistantTypingInProgress(message) {
  if (!message || message.role !== "assistant") {
    return false;
  }
  const fullText = typeof message.text === "string" ? message.text : "";
  if (!fullText) {
    return false;
  }
  const entry = assistantTypingState.get(message.id);
  if (!entry) {
    return false;
  }
  return entry.shownLength < fullText.length;
}

function applyAssistantTypingToDom(session) {
  if (!session || !Array.isArray(session.messages)) {
    return;
  }

  for (const message of session.messages) {
    if (!message || message.role !== "assistant") {
      continue;
    }

    const bubble = messages.querySelector(`[data-message-id="${message.id}"]`);
    if (!bubble) {
      continue;
    }

    const textNode = bubble.querySelector(".message-text");
    if (textNode) {
      textNode.textContent = resolveMessageDisplayText(message) || "";
    }

    if (isAssistantTypingInProgress(message)) {
      bubble.classList.add("typing");
    } else {
      bubble.classList.remove("typing");
    }
  }
}

function advanceAssistantTypingLoop() {
  const session = getCurrentSession();
  if (!session || !Array.isArray(session.messages)) {
    stopAssistantTypingLoop();
    return;
  }

  const tick = now();
  let hasPending = false;
  let didAdvance = false;

  for (const message of session.messages) {
    if (!message || message.role !== "assistant") {
      continue;
    }

    const fullText = typeof message.text === "string" ? message.text : "";
    if (!shouldAnimateAssistantText(message, fullText)) {
      continue;
    }

    const entry = assistantTypingState.get(message.id);
    if (!entry) {
      continue;
    }

    if (entry.fullText !== fullText) {
      entry.fullText = fullText;
      entry.shownLength = Math.min(entry.shownLength, fullText.length);
      entry.lastTick = tick;
    }

    if (entry.shownLength >= fullText.length) {
      continue;
    }

    hasPending = true;
    const elapsedMs = Math.max(ASSISTANT_TYPING_TICK_MS, tick - entry.lastTick);
    const step = Math.max(1, Math.floor((elapsedMs * ASSISTANT_TYPING_SPEED_CHARS_PER_SEC) / 1000));
    const nextLength = Math.min(fullText.length, entry.shownLength + step);

    if (nextLength !== entry.shownLength) {
      entry.shownLength = nextLength;
      didAdvance = true;
    }
    entry.lastTick = tick;

    if (entry.shownLength < fullText.length) {
      hasPending = true;
    }
  }

  if (didAdvance) {
    applyAssistantTypingToDom(session);
    scrollMessagesToBottom(false);
  }
  if (!hasPending) {
    stopAssistantTypingLoop();
  }
}

function normalizeModelProfile(value) {
  const next = trimString(value, "").toLowerCase();
  if (PROFILE_BY_VALUE.has(next)) {
    return next;
  }
  if (MODEL_ALIAS_TO_PROFILE.has(next)) {
    return MODEL_ALIAS_TO_PROFILE.get(next);
  }
  return DEFAULT_MODEL_PROFILE;
}

function getProfile(session) {
  const key = normalizeModelProfile(session && session.model);
  return PROFILE_BY_VALUE.get(key) || PROFILE_BY_VALUE.get(DEFAULT_MODEL_PROFILE);
}

function createNewSession() {
  const timestamp = now();
  return {
    id: uid(),
    title: "New Chat",
    createdAt: timestamp,
    updatedAt: timestamp,
    threadId: "",
    workspaceDir: "",
    model: DEFAULT_MODEL_PROFILE,
    reasoningEffort: DEFAULT_REASONING,
    approvalPolicy: DEFAULT_APPROVAL,
    messages: []
  };
}

function sanitizeState(raw) {
  const safe = {
    settings: {
      codexCommand: "codex"
    },
    sessions: [],
    currentSessionId: null
  };

  if (raw && typeof raw === "object") {
    if (raw.settings && typeof raw.settings === "object") {
      safe.settings.codexCommand = trimString(raw.settings.codexCommand, "codex");
    }
    if (Array.isArray(raw.sessions)) {
      safe.sessions = raw.sessions
        .filter((session) => session && typeof session === "object")
        .map((session) => ({
          id: trimString(session.id, uid()),
          title: trimString(session.title, "New Chat"),
          createdAt: Number.isFinite(session.createdAt) ? session.createdAt : now(),
          updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : now(),
          threadId: trimString(session.threadId, ""),
          workspaceDir: trimString(session.workspaceDir, ""),
          model: normalizeModelProfile(session.model),
          reasoningEffort: trimString(session.reasoningEffort, DEFAULT_REASONING),
          approvalPolicy: trimString(session.approvalPolicy, DEFAULT_APPROVAL),
          messages: Array.isArray(session.messages)
            ? session.messages
                .filter((message) => message && typeof message === "object")
                .map((message) => ({
                  id: trimString(message.id, uid()),
                  role: message.role === "assistant" ? "assistant" : "user",
                  text: typeof message.text === "string" ? message.text : "",
                  commands: Array.isArray(message.commands)
                    ? message.commands.filter((command) => typeof command === "string" && command.trim())
                    : [],
                  terminalLog: Array.isArray(message.terminalLog)
                    ? message.terminalLog.filter((entry) => typeof entry === "string" && entry.trim())
                    : [],
                  usage: sanitizeUsage(message.usage),
                  images: Array.isArray(message.images)
                    ? message.images.filter((path) => typeof path === "string")
                    : [],
                  error: Boolean(message.error),
                  pending: false,
                  timestamp: Number.isFinite(message.timestamp) ? message.timestamp : now()
                }))
            : []
        }));
    }
    if (typeof raw.currentSessionId === "string" && raw.currentSessionId.trim()) {
      safe.currentSessionId = raw.currentSessionId.trim();
    }
  }

  if (!safe.sessions.length) {
    const session = createNewSession();
    safe.sessions = [session];
    safe.currentSessionId = session.id;
  }

  if (!safe.sessions.some((session) => session.id === safe.currentSessionId)) {
    safe.currentSessionId = safe.sessions[0].id;
  }

  return safe;
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.codexDesktop.saveState(state).catch((error) => {
      console.error("Failed to save state:", error);
    });
  }, 250);
}

function getCurrentSession() {
  return state.sessions.find((session) => session.id === state.currentSessionId) || null;
}

function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleString();
}

function relativeShort(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const deltaMs = Math.max(0, now() - timestamp);
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return new Date(timestamp).toLocaleDateString();
}

function displayNameFromPath(filePath) {
  if (typeof filePath !== "string") {
    return "";
  }
  const normalized = filePath.replace(/\//g, "\\");
  const segments = normalized.split("\\");
  return segments[segments.length - 1] || filePath;
}

function leafFromPath(filePath) {
  if (typeof filePath !== "string") {
    return "";
  }
  const normalized = filePath.replace(/\//g, "\\");
  const segments = normalized.split("\\").filter(Boolean);
  return segments[segments.length - 1] || filePath;
}

function formatSignedCount(value, prefix) {
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }
  return `${prefix}${value.toLocaleString()}`;
}

function buildChangesCountLabel(fileCount) {
  if (!Number.isInteger(fileCount) || fileCount <= 0) {
    return "0 files changed";
  }
  return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
}

function createChangeLineElement(line) {
  const item = document.createElement("code");
  item.className = "change-line";

  const type = line && typeof line.type === "string" ? line.type : "ctx";
  if (type === "add" || type === "del" || type === "hunk" || type === "meta") {
    item.classList.add(type);
  } else {
    item.classList.add("ctx");
  }

  item.textContent = line && typeof line.text === "string" ? line.text : "";
  return item;
}

function clearSelectedChangeView() {
  selectedChangePath = "";
  selectedChangeView = {
    path: "",
    loading: false,
    error: "",
    text: "",
    truncated: false
  };
}

function renderChangeCodeViewer() {
  if (!changeCodeViewer) {
    return;
  }

  changeCodeViewer.innerHTML = "";
  const session = getCurrentSession();
  const hasWorkspace = Boolean(session && trimString(session.workspaceDir, ""));

  if (!hasWorkspace) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = "Select a workspace folder to inspect code.";
    changeCodeViewer.appendChild(empty);
    return;
  }

  if (!selectedChangePath) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = "Click a file above to view its code.";
    changeCodeViewer.appendChild(empty);
    return;
  }

  const head = document.createElement("div");
  head.className = "change-code-head";
  const pathEl = document.createElement("div");
  pathEl.className = "change-code-path";
  pathEl.textContent = selectedChangePath;
  pathEl.title = selectedChangePath;
  const metaEl = document.createElement("div");
  metaEl.className = "change-code-meta";
  if (selectedChangeView.loading) {
    metaEl.textContent = "Loading...";
  } else if (selectedChangeView.error) {
    metaEl.textContent = "Unavailable";
  } else if (selectedChangeView.text) {
    const lineCount = selectedChangeView.text.split("\n").length;
    metaEl.textContent = `${lineCount} lines${selectedChangeView.truncated ? " (truncated)" : ""}`;
  } else {
    metaEl.textContent = selectedChangeView.truncated ? "Truncated" : "";
  }
  head.appendChild(pathEl);
  head.appendChild(metaEl);
  changeCodeViewer.appendChild(head);

  const body = document.createElement("div");
  body.className = "change-code-body";

  if (selectedChangeView.loading) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = "Loading file...";
    body.appendChild(empty);
    changeCodeViewer.appendChild(body);
    return;
  }

  if (selectedChangeView.error) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = selectedChangeView.error;
    body.appendChild(empty);
    changeCodeViewer.appendChild(body);
    return;
  }

  if (!selectedChangeView.text) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = "No text content to display.";
    body.appendChild(empty);
    changeCodeViewer.appendChild(body);
    return;
  }

  const lines = selectedChangeView.text.split("\n");
  const maxLines = 900;
  const visible = lines.slice(0, maxLines);
  for (let i = 0; i < visible.length; i += 1) {
    const row = document.createElement("div");
    row.className = "change-code-line";

    const no = document.createElement("span");
    no.className = "change-code-line-no";
    no.textContent = String(i + 1);

    const text = document.createElement("span");
    text.className = "change-code-line-text";
    text.textContent = visible[i];

    row.appendChild(no);
    row.appendChild(text);
    body.appendChild(row);
  }

  if (lines.length > maxLines) {
    const empty = document.createElement("div");
    empty.className = "change-code-empty";
    empty.textContent = `Showing first ${maxLines} lines of ${lines.length}.`;
    body.appendChild(empty);
  }

  changeCodeViewer.appendChild(body);
}

async function loadSelectedChangeCode(relPath) {
  const session = getCurrentSession();
  const safePath = trimString(relPath, "");
  if (!session || !trimString(session.workspaceDir, "") || !safePath) {
    clearSelectedChangeView();
    renderChangeCodeViewer();
    return;
  }

  const workspaceDir = trimString(session.workspaceDir, "");
  const sessionId = session.id;
  const loadToken = ++selectedChangeLoadToken;
  selectedChangeView = {
    path: safePath,
    loading: true,
    error: "",
    text: "",
    truncated: false
  };
  renderChangeCodeViewer();

  try {
    const result = await window.codexDesktop.readWorkspaceFile({
      workspaceDir,
      relPath: safePath
    });

    const activeSession = getCurrentSession();
    if (!activeSession || activeSession.id !== sessionId) {
      return;
    }
    if (selectedChangeLoadToken !== loadToken || selectedChangePath !== safePath) {
      return;
    }

    if (!result || result.ok === false) {
      selectedChangeView = {
        path: safePath,
        loading: false,
        error:
          (result && typeof result.message === "string" && result.message.trim()) ||
          "Unable to read file.",
        text: "",
        truncated: false
      };
    } else {
      selectedChangeView = {
        path: safePath,
        loading: false,
        error: "",
        text: typeof result.text === "string" ? result.text : "",
        truncated: Boolean(result.truncated)
      };
    }
  } catch (error) {
    if (selectedChangeLoadToken !== loadToken || selectedChangePath !== safePath) {
      return;
    }
    selectedChangeView = {
      path: safePath,
      loading: false,
      error: `Unable to read file: ${error && error.message ? error.message : String(error)}`,
      text: "",
      truncated: false
    };
  }

  renderChangeCodeViewer();
}

function syncSelectedChangeForCurrentList() {
  const files = Array.isArray(workspaceChanges) ? workspaceChanges : [];
  if (!files.length) {
    clearSelectedChangeView();
    return;
  }

  const existing = files.some((file) => file && file.path === selectedChangePath);
  const nextPath = existing ? selectedChangePath : trimString(files[0] && files[0].path, "");
  if (!nextPath) {
    clearSelectedChangeView();
    return;
  }

  selectedChangePath = nextPath;
  if (selectedChangeView.path !== nextPath || (!selectedChangeView.text && !selectedChangeView.loading && !selectedChangeView.error)) {
    selectedChangeView = {
      path: nextPath,
      loading: true,
      error: "",
      text: "",
      truncated: false
    };
    loadSelectedChangeCode(nextPath);
  }
}

function resolveModel(session) {
  return getProfile(session).model;
}

function resolveModelProfileValue(session) {
  return getProfile(session).value;
}

function resolveReasoning(session) {
  const value = trimString(session.reasoningEffort, DEFAULT_REASONING).toLowerCase();
  if (value === "very_high" || value === "xhigh" || value === "extra_high") {
    return "high";
  }
  if (value === "minimal") {
    return "low";
  }
  if (!REASONING_OPTIONS.some((option) => option.value === value)) {
    return DEFAULT_REASONING;
  }
  return value;
}

function resolveApproval(session) {
  const value = trimString(session.approvalPolicy, DEFAULT_APPROVAL).toLowerCase();
  if (!APPROVAL_OPTIONS.some((option) => option.value === value)) {
    return DEFAULT_APPROVAL;
  }
  return value;
}

function normalizeUsageValue(value) {
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

function sanitizeUsage(raw) {
  const usage = raw && typeof raw === "object" ? raw : {};
  return {
    inputTokens: normalizeUsageValue(usage.inputTokens),
    outputTokens: normalizeUsageValue(usage.outputTokens),
    totalTokens: normalizeUsageValue(usage.totalTokens),
    reasoningTokens: normalizeUsageValue(usage.reasoningTokens),
    remainingTokens: normalizeUsageValue(usage.remainingTokens),
    remainingRequests: normalizeUsageValue(usage.remainingRequests),
    cumulativeInputTokens: normalizeUsageValue(usage.cumulativeInputTokens),
    cumulativeOutputTokens: normalizeUsageValue(usage.cumulativeOutputTokens),
    cumulativeTotalTokens: normalizeUsageValue(usage.cumulativeTotalTokens),
    cumulativeReasoningTokens: normalizeUsageValue(usage.cumulativeReasoningTokens),
    rateLimitPrimaryUsedPercent: normalizeUsageValue(usage.rateLimitPrimaryUsedPercent),
    rateLimitSecondaryUsedPercent: normalizeUsageValue(usage.rateLimitSecondaryUsedPercent),
    rateLimitPrimaryWindowMinutes: normalizeUsageValue(usage.rateLimitPrimaryWindowMinutes),
    rateLimitSecondaryWindowMinutes: normalizeUsageValue(usage.rateLimitSecondaryWindowMinutes)
  };
}

function formatInt(value) {
  if (!Number.isInteger(value)) {
    return "--";
  }
  return value.toLocaleString();
}

function getSessionTokenTotals(session) {
  const totals = {
    hasData: false,
    fromCumulative: false,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };

  if (!session || !Array.isArray(session.messages)) {
    return totals;
  }

  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (!message || !message.usage || typeof message.usage !== "object") {
      continue;
    }
    if (Number.isInteger(message.usage.cumulativeTotalTokens)) {
      totals.hasData = true;
      totals.fromCumulative = true;
      totals.inputTokens = Number.isInteger(message.usage.cumulativeInputTokens)
        ? message.usage.cumulativeInputTokens
        : 0;
      totals.outputTokens = Number.isInteger(message.usage.cumulativeOutputTokens)
        ? message.usage.cumulativeOutputTokens
        : 0;
      totals.totalTokens = message.usage.cumulativeTotalTokens;
      return totals;
    }
  }

  for (const message of session.messages) {
    if (!message || typeof message !== "object" || !message.usage || typeof message.usage !== "object") {
      continue;
    }
    if (Number.isInteger(message.usage.inputTokens)) {
      totals.inputTokens += message.usage.inputTokens;
      totals.hasData = true;
    }
    if (Number.isInteger(message.usage.outputTokens)) {
      totals.outputTokens += message.usage.outputTokens;
      totals.hasData = true;
    }
    if (Number.isInteger(message.usage.totalTokens)) {
      totals.totalTokens += message.usage.totalTokens;
      totals.hasData = true;
    }
  }

  return totals;
}

function getLatestAssistantUsage(session) {
  if (!session || !Array.isArray(session.messages)) {
    return null;
  }

  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (!message || message.role !== "assistant" || !message.usage) {
      continue;
    }
    return message.usage;
  }

  return null;
}

function setStatus(text) {
  statusText.textContent = text;
}

function scrollMessagesToBottom(force = false) {
  if (!messages) {
    return;
  }

  const distanceFromBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop;
  const isNearBottom = distanceFromBottom <= 80;
  if (!force && !isNearBottom) {
    return;
  }

  const apply = () => {
    messages.scrollTop = messages.scrollHeight;
  };

  apply();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(apply);
  }
}

function hideStartupSplash() {
  if (!startupSplash) {
    return;
  }
  setTimeout(() => {
    startupSplash.classList.add("hidden");
  }, 450);
}

function fillSelect(selectEl, options, value) {
  selectEl.innerHTML = "";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    selectEl.appendChild(el);
  }
  selectEl.value = value;
}

function renderModelControls(session) {
  modelSelect.innerHTML = "";
  for (const option of MODEL_PROFILES) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    modelSelect.appendChild(el);
  }
  modelSelect.value = resolveModelProfileValue(session);
}

function renderReasoningApprovalControls(session) {
  fillSelect(reasoningSelect, REASONING_OPTIONS, resolveReasoning(session));
  fillSelect(approvalSelect, APPROVAL_OPTIONS, resolveApproval(session));
}

function renderSessionList() {
  sessionList.innerHTML = "";

  for (const session of state.sessions) {
    const row = document.createElement("div");
    row.className = "session-item";
    if (session.id === state.currentSessionId) {
      row.classList.add("active");
    }
    row.dataset.sessionId = session.id;

    const title = document.createElement("div");
    title.className = "session-item-title";
    title.textContent = session.title || "New Chat";

    const meta = document.createElement("div");
    meta.className = "session-item-meta";

    const dateText = document.createElement("span");
    dateText.textContent = relativeShort(session.updatedAt);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "session-delete";
    deleteBtn.dataset.deleteSessionId = session.id;
    deleteBtn.title = "Delete chat";
    deleteBtn.textContent = "x";

    meta.appendChild(dateText);
    meta.appendChild(deleteBtn);

    row.appendChild(title);
    row.appendChild(meta);
    sessionList.appendChild(row);
  }
}

function renderTopbar(session) {
  if (topThreadTitle) {
    topThreadTitle.textContent = trimString(session.title, "New thread");
  }

  if (topRepoName) {
    const workspaceDir = trimString(session.workspaceDir, "");
    if (!workspaceDir) {
      topRepoName.textContent = "No workspace selected";
      topRepoName.title = "";
      return;
    }

    topRepoName.textContent = leafFromPath(workspaceDir);
    topRepoName.title = workspaceDir;
  }
}

function renderWorkspace(session) {
  workspacePath.textContent = session.workspaceDir || "No workspace selected";
}

function renderSidebarAccount(session) {
  if (!accountIdentity || !tokenUsageSummary || !tokenRemainingSummary) {
    return;
  }

  if (!codexStatus || codexStatus.loggedIn === false || codexStatus.installed === false) {
    accountIdentity.textContent = "Not signed in";
  } else {
    const account = trimString(codexStatus.accountLabel, "");
    const provider = trimString(codexStatus.providerLabel, "");
    accountIdentity.textContent = account || provider || "Signed in";
  }

  const statusPrimaryUsedPercent =
    codexStatus && Number.isInteger(codexStatus.rateLimitPrimaryUsedPercent)
      ? codexStatus.rateLimitPrimaryUsedPercent
      : null;
  const statusSecondaryUsedPercent =
    codexStatus && Number.isInteger(codexStatus.rateLimitSecondaryUsedPercent)
      ? codexStatus.rateLimitSecondaryUsedPercent
      : null;
  const statusPrimaryWindowMinutes =
    codexStatus && Number.isInteger(codexStatus.rateLimitPrimaryWindowMinutes)
      ? codexStatus.rateLimitPrimaryWindowMinutes
      : null;
  const statusSecondaryWindowMinutes =
    codexStatus && Number.isInteger(codexStatus.rateLimitSecondaryWindowMinutes)
      ? codexStatus.rateLimitSecondaryWindowMinutes
      : null;
  const statusCreditsBalance = codexStatus ? trimString(codexStatus.creditsBalance, "") : "";
  const statusCreditsUnlimited = Boolean(codexStatus && codexStatus.creditsUnlimited === true);

  const totals = getSessionTokenTotals(session);
  if (totals.hasData && totals.totalTokens > 0) {
    tokenUsageSummary.textContent = `Chat tokens: ${formatInt(totals.totalTokens)}`;
  } else if (totals.hasData && (totals.inputTokens > 0 || totals.outputTokens > 0)) {
    tokenUsageSummary.textContent = `Chat tokens: ${formatInt(totals.inputTokens + totals.outputTokens)}`;
  } else if (Number.isInteger(statusPrimaryUsedPercent)) {
    tokenUsageSummary.textContent = `Chat tokens: ${statusPrimaryUsedPercent}% used`;
  } else if (Number.isInteger(statusSecondaryUsedPercent)) {
    tokenUsageSummary.textContent = `Chat tokens: ${statusSecondaryUsedPercent}% used`;
  } else {
    tokenUsageSummary.textContent = "Chat tokens: --";
  }

  const latestUsage = getLatestAssistantUsage(session);
  const remainingTokens = latestUsage ? latestUsage.remainingTokens : null;
  const remainingRequests = latestUsage ? latestUsage.remainingRequests : null;
  if (Number.isInteger(remainingTokens)) {
    tokenRemainingSummary.textContent = `Usage left: ${formatInt(remainingTokens)} tokens`;
    return;
  }
  if (Number.isInteger(remainingRequests)) {
    tokenRemainingSummary.textContent = `Usage left: ${formatInt(remainingRequests)} requests`;
    return;
  }

  if (statusCreditsUnlimited) {
    tokenRemainingSummary.textContent = "Usage left: Unlimited";
    return;
  }
  if (statusCreditsBalance) {
    tokenRemainingSummary.textContent = `Usage left: ${statusCreditsBalance}`;
    return;
  }

  const primaryUsedPercent = latestUsage ? latestUsage.rateLimitPrimaryUsedPercent : null;
  const primaryWindowMinutes = latestUsage ? latestUsage.rateLimitPrimaryWindowMinutes : null;
  const primaryUsed = Number.isInteger(primaryUsedPercent) ? primaryUsedPercent : statusPrimaryUsedPercent;
  const primaryWindow = Number.isInteger(primaryWindowMinutes) ? primaryWindowMinutes : statusPrimaryWindowMinutes;
  if (Number.isInteger(primaryUsed)) {
    const leftPercent = Math.max(0, Math.min(100, 100 - primaryUsed));
    tokenRemainingSummary.textContent = Number.isInteger(primaryWindow)
      ? `Usage left: ${leftPercent}% (${primaryWindow}m window)`
      : `Usage left: ${leftPercent}%`;
    return;
  }

  const secondaryUsedPercent = latestUsage ? latestUsage.rateLimitSecondaryUsedPercent : null;
  const secondaryWindowMinutes = latestUsage ? latestUsage.rateLimitSecondaryWindowMinutes : null;
  const secondaryUsed = Number.isInteger(secondaryUsedPercent)
    ? secondaryUsedPercent
    : statusSecondaryUsedPercent;
  const secondaryWindow = Number.isInteger(secondaryWindowMinutes)
    ? secondaryWindowMinutes
    : statusSecondaryWindowMinutes;
  if (Number.isInteger(secondaryUsed)) {
    const leftPercent = Math.max(0, Math.min(100, 100 - secondaryUsed));
    tokenRemainingSummary.textContent = Number.isInteger(secondaryWindow)
      ? `Usage left: ${leftPercent}% (${secondaryWindow}m window)`
      : `Usage left: ${leftPercent}%`;
    return;
  }

  tokenRemainingSummary.textContent = "Usage left: --";
}

function renderWorkspaceChanges() {
  const session = getCurrentSession();
  const hasWorkspace = Boolean(session && trimString(session.workspaceDir, ""));
  const files = Array.isArray(workspaceChanges) ? workspaceChanges : [];
  const fileCount = files.length;

  const additions = formatSignedCount(workspaceChangesTotals.additions, "+");
  const deletions = formatSignedCount(workspaceChangesTotals.deletions, "-");
  let countLabel = buildChangesCountLabel(fileCount);
  if (fileCount > 0 && (additions || deletions)) {
    countLabel = [countLabel, additions || "", deletions || ""].filter(Boolean).join("  ");
  }
  changesCount.textContent = countLabel;

  if (changesMeta) {
    if (!hasWorkspace) {
      changesMeta.textContent = "Select a workspace folder to view git changes.";
    } else if (workspaceChangesLoading) {
      changesMeta.textContent = "Scanning git diff...";
    } else if (workspaceChangesMessage) {
      changesMeta.textContent = workspaceChangesMessage;
    } else {
      changesMeta.textContent = "Latest code changes from the selected workspace.";
    }
  }

  if (!workspaceChangesLoading && hasWorkspace && fileCount > 0) {
    syncSelectedChangeForCurrentList();
  } else if (!workspaceChangesLoading && (!hasWorkspace || fileCount === 0)) {
    clearSelectedChangeView();
  }
  changesList.innerHTML = "";

  if (!hasWorkspace || workspaceChangesLoading || !fileCount) {
    const empty = document.createElement("div");
    empty.className = "change-empty";
    if (!hasWorkspace) {
      empty.textContent = "No workspace selected.";
    } else if (workspaceChangesLoading) {
      empty.textContent = "Loading code changes...";
    } else {
      empty.textContent = workspaceChangesMessage || "No code changes detected.";
    }
    changesList.appendChild(empty);
    renderChangeCodeViewer();
    return;
  }

  for (const file of files) {
    const card = document.createElement("article");
    card.className = "change-card";
    card.dataset.changePath = typeof file.path === "string" ? file.path : "";
    if (card.dataset.changePath && card.dataset.changePath === selectedChangePath) {
      card.classList.add("active");
    }

    const cardHeader = document.createElement("div");
    cardHeader.className = "change-card-header";

    const filePath = document.createElement("div");
    filePath.className = "change-file-path";
    filePath.textContent = typeof file.path === "string" ? file.path : "(unknown file)";
    filePath.title = filePath.textContent;

    const stats = document.createElement("div");
    stats.className = "change-stats";

    const add = document.createElement("span");
    add.className = Number.isInteger(file.additions) ? "change-stats-add" : "change-stats-na";
    add.textContent = Number.isInteger(file.additions) ? `+${file.additions}` : "+?";
    stats.appendChild(add);

    const del = document.createElement("span");
    del.className = Number.isInteger(file.deletions) ? "change-stats-del" : "change-stats-na";
    del.textContent = Number.isInteger(file.deletions) ? `-${file.deletions}` : "-?";
    stats.appendChild(del);

    cardHeader.appendChild(filePath);
    cardHeader.appendChild(stats);
    card.appendChild(cardHeader);

    const diffBox = document.createElement("div");
    diffBox.className = "change-diff";

    const previewLines = Array.isArray(file.preview) ? file.preview : [];
    if (!previewLines.length) {
      diffBox.appendChild(
        createChangeLineElement({
          type: "meta",
          text: "(No text diff preview available.)"
        })
      );
    } else {
      for (const line of previewLines) {
        diffBox.appendChild(createChangeLineElement(line));
      }
    }

    if (file.truncated) {
      diffBox.appendChild(
        createChangeLineElement({
          type: "meta",
          text: "(Preview truncated. Open file for full diff.)"
        })
      );
    }

    card.appendChild(diffBox);
    changesList.appendChild(card);
  }

  renderChangeCodeViewer();
}

function renderAttachments() {
  attachmentList.innerHTML = "";
  for (const [index, imagePath] of pendingImages.entries()) {
    const item = document.createElement("div");
    item.className = "attachment";

    const text = document.createElement("span");
    text.textContent = displayNameFromPath(imagePath);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "x";
    removeBtn.dataset.removeAttachmentIndex = String(index);
    removeBtn.title = "Remove image";

    item.appendChild(text);
    item.appendChild(removeBtn);
    attachmentList.appendChild(item);
  }
}

function renderMessages(forceScrollBottom = false) {
  const session = getCurrentSession();
  messages.innerHTML = "";
  if (!session) {
    return;
  }

  if (!session.messages.length) {
    const empty = document.createElement("div");
    empty.className = "message assistant";
    empty.textContent = "Start a chat. Pick a folder and model, then send a prompt.";
    messages.appendChild(empty);
    return;
  }

  for (const message of session.messages) {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role}`;
    bubble.dataset.messageId = message.id;
    if (message.error) {
      bubble.classList.add("error");
    }

    const textBlock = document.createElement("div");
    textBlock.className = "message-text";
    textBlock.textContent = resolveMessageDisplayText(message) || "";
    bubble.appendChild(textBlock);

    if (isAssistantTypingInProgress(message)) {
      bubble.classList.add("typing");
    }

    if (Array.isArray(message.commands) && message.commands.length) {
      const commandWrap = document.createElement("div");
      commandWrap.className = "message-commands";

      const title = document.createElement("div");
      title.className = "message-commands-title";
      title.textContent = "Commands run:";
      commandWrap.appendChild(title);

      for (const commandText of message.commands) {
        const code = document.createElement("code");
        code.className = "message-command";
        code.textContent = commandText;
        commandWrap.appendChild(code);
      }

      bubble.appendChild(commandWrap);
    }

    if (Array.isArray(message.terminalLog) && message.terminalLog.length) {
      const terminalWrap = document.createElement("div");
      terminalWrap.className = "message-terminal";

      const title = document.createElement("div");
      title.className = "message-terminal-title";
      title.textContent = "Terminal output:";
      terminalWrap.appendChild(title);

      for (const terminalText of message.terminalLog) {
        const pre = document.createElement("pre");
        pre.className = "message-terminal-entry";
        pre.textContent = terminalText;
        terminalWrap.appendChild(pre);
      }

      bubble.appendChild(terminalWrap);
    }

    if (Array.isArray(message.images) && message.images.length) {
      const imageWrap = document.createElement("div");
      imageWrap.className = "message-images";
      for (const imagePath of message.images) {
        const pill = document.createElement("span");
        pill.className = "pill";
        pill.textContent = displayNameFromPath(imagePath);
        imageWrap.appendChild(pill);
      }
      bubble.appendChild(imageWrap);
    }

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const metaParts = [relativeTime(message.timestamp)];
    if (message.usage && typeof message.usage === "object") {
      const inTokens = message.usage.inputTokens;
      const outTokens = message.usage.outputTokens;
      const totalTokens = message.usage.totalTokens;
      if (Number.isInteger(totalTokens)) {
        metaParts.push(`tokens ${formatInt(totalTokens)}`);
      } else if (Number.isInteger(inTokens) || Number.isInteger(outTokens)) {
        metaParts.push(`in ${formatInt(inTokens)} / out ${formatInt(outTokens)}`);
      }
      if (Number.isInteger(message.usage.remainingTokens)) {
        metaParts.push(`left ${formatInt(message.usage.remainingTokens)}`);
      }
    }
    meta.textContent = metaParts.filter(Boolean).join("  •  ");
    bubble.appendChild(meta);

    messages.appendChild(bubble);
  }

  scrollMessagesToBottom(forceScrollBottom);
}

function renderCommand() {
  codexCommandInput.value = trimString(state.settings.codexCommand, "codex");
}

function setBadge(kind, text) {
  codexHealthBadge.className = "status-badge";
  if (kind) {
    codexHealthBadge.classList.add(kind);
  }
  codexHealthBadge.textContent = text;
}

function appendPanelLine(text) {
  const line = document.createElement("div");
  line.className = "codex-status-line";
  line.textContent = text;
  codexStatusPanel.appendChild(line);
}

function appendPanelCommand(text) {
  const cmd = document.createElement("code");
  cmd.className = "codex-install-command";
  cmd.textContent = text;
  codexStatusPanel.appendChild(cmd);
}

function renderCodexStatus() {
  codexStatusPanel.className = "codex-status-panel";
  codexStatusPanel.innerHTML = "";

  if (codexStatusLoading) {
    setBadge("warn", "Checking...");
    const title = document.createElement("div");
    title.className = "codex-status-title";
    title.textContent = "Checking Codex status...";
    codexStatusPanel.appendChild(title);
    return;
  }

  if (!codexStatus) {
    setBadge("warn", "Not Checked");
    const title = document.createElement("div");
    title.className = "codex-status-title";
    title.textContent = "Click Refresh Status to check install and login.";
    codexStatusPanel.appendChild(title);
    return;
  }

  if (!codexStatus.installed) {
    codexStatusPanel.classList.add("bad");
    setBadge("bad", "Codex Missing");

    const title = document.createElement("div");
    title.className = "codex-status-title";
    title.textContent = "Codex CLI not found (spawn ENOENT).";
    codexStatusPanel.appendChild(title);

    appendPanelLine(`Command: ${trimString(state.settings.codexCommand, "codex")}`);
    appendPanelLine("Install Codex CLI, then login, then click Refresh Status:");
    appendPanelCommand("npm install -g @openai/codex");
    appendPanelCommand("codex login");
    return;
  }

  if (codexStatus.loggedIn === false) {
    codexStatusPanel.classList.add("warn");
    setBadge("warn", "Login Needed");

    const title = document.createElement("div");
    title.className = "codex-status-title";
    title.textContent = "Codex is installed, but you are not logged in.";
    codexStatusPanel.appendChild(title);

    if (codexStatus.version) {
      appendPanelLine(`Version: ${codexStatus.version}`);
    }
    appendPanelLine(trimString(codexStatus.statusText, "Run codex login in terminal."));
    appendPanelCommand("codex login");
    appendPanelLine("After login, click Refresh Status.");
    return;
  }

  codexStatusPanel.classList.add("good");
  setBadge("good", "Ready");

  const title = document.createElement("div");
  title.className = "codex-status-title";
  title.textContent = "Codex is ready.";
  codexStatusPanel.appendChild(title);

  if (codexStatus.version) {
    appendPanelLine(`Version: ${codexStatus.version}`);
  }
  const account = trimString(codexStatus.accountLabel, "");
  if (account && account !== "Unknown") {
    appendPanelLine(`Account: ${account}`);
  }
  const planType = trimString(codexStatus.planType, "");
  if (planType) {
    appendPanelLine(`Plan: ${planType}`);
  }
  if (Number.isInteger(codexStatus.rateLimitPrimaryUsedPercent)) {
    const used = codexStatus.rateLimitPrimaryUsedPercent;
    const left = Math.max(0, Math.min(100, 100 - used));
    const windowMinutes = Number.isInteger(codexStatus.rateLimitPrimaryWindowMinutes)
      ? ` (${codexStatus.rateLimitPrimaryWindowMinutes}m window)`
      : "";
    appendPanelLine(`Primary usage: ${left}% left${windowMinutes}`);
  }
  if (Number.isInteger(codexStatus.rateLimitSecondaryUsedPercent)) {
    const used = codexStatus.rateLimitSecondaryUsedPercent;
    const left = Math.max(0, Math.min(100, 100 - used));
    const windowMinutes = Number.isInteger(codexStatus.rateLimitSecondaryWindowMinutes)
      ? ` (${codexStatus.rateLimitSecondaryWindowMinutes}m window)`
      : "";
    appendPanelLine(`Secondary usage: ${left}% left${windowMinutes}`);
  }
  const creditBalance = trimString(codexStatus.creditsBalance, "");
  if (codexStatus.creditsUnlimited === true) {
    appendPanelLine("Credits: unlimited");
  } else if (creditBalance) {
    appendPanelLine(`Credits: ${creditBalance}`);
  }
  if (codexStatus.statusText) {
    appendPanelLine(codexStatus.statusText);
  }
}

function renderBusyState() {
  const isBusy = Boolean(activeRequestId);
  sendBtn.disabled = isBusy;
  cancelBtn.disabled = !isBusy;
  promptInput.disabled = isBusy;
  attachImageBtn.disabled = isBusy;
  openFolderBtn.disabled = isBusy;
  clearFolderBtn.disabled = isBusy;
  refreshStatusBtn.disabled = isBusy || codexStatusLoading;
}

function render() {
  const session = getCurrentSession();
  if (!session) {
    return;
  }
  renderTopbar(session);
  renderSessionList();
  renderModelControls(session);
  renderReasoningApprovalControls(session);
  renderWorkspace(session);
  renderSidebarAccount(session);
  renderCommand();
  renderAttachments();
  renderMessages();
  renderWorkspaceChanges();
  renderCodexStatus();
  renderBusyState();
}

async function refreshWorkspaceChanges() {
  const session = getCurrentSession();
  if (!session || !session.workspaceDir) {
    workspaceChanges = [];
    workspaceChangesTotals = { additions: 0, deletions: 0 };
    workspaceChangesMessage = "Select a workspace folder to view git changes.";
    workspaceChangesLoading = false;
    clearSelectedChangeView();
    renderWorkspaceChanges();
    return;
  }

  const sessionId = session.id;
  workspaceChangesLoading = true;
  workspaceChangesMessage = "";
  renderWorkspaceChanges();

  try {
    const result = await window.codexDesktop.listWorkspaceChanges(session.workspaceDir);
    const activeSession = getCurrentSession();
    if (!activeSession || activeSession.id !== sessionId) {
      return;
    }

    if (!result || result.ok === false) {
      workspaceChanges = [];
      workspaceChangesTotals = { additions: 0, deletions: 0 };
      workspaceChangesMessage =
        (result && typeof result.message === "string" && result.message.trim()) ||
        "Failed to load git changes.";
      clearSelectedChangeView();
      return;
    }

    workspaceChanges = Array.isArray(result.files) ? result.files : [];
    workspaceChangesTotals =
      result && result.totals && typeof result.totals === "object"
        ? {
            additions: Number.isInteger(result.totals.additions) ? result.totals.additions : 0,
            deletions: Number.isInteger(result.totals.deletions) ? result.totals.deletions : 0
          }
        : { additions: 0, deletions: 0 };

    if (selectedChangePath && workspaceChanges.some((file) => file && file.path === selectedChangePath)) {
      selectedChangeView = {
        path: selectedChangePath,
        loading: true,
        error: "",
        text: "",
        truncated: false
      };
      loadSelectedChangeCode(selectedChangePath);
    }

    if (workspaceChanges.length) {
      workspaceChangesMessage = "";
    } else {
      workspaceChangesMessage =
        (result && typeof result.message === "string" && result.message.trim()) || "No code changes detected.";
      clearSelectedChangeView();
    }
  } catch (error) {
    console.error("Failed to read workspace changes:", error);
    workspaceChanges = [];
    workspaceChangesTotals = { additions: 0, deletions: 0 };
    workspaceChangesMessage = "Failed to read workspace changes.";
    clearSelectedChangeView();
  } finally {
    workspaceChangesLoading = false;
    renderWorkspaceChanges();
  }
}

async function refreshCodexStatus() {
  codexStatusLoading = true;
  renderCodexStatus();
  renderBusyState();
  renderSidebarAccount(getCurrentSession());

  try {
    codexStatus = await window.codexDesktop.getCodexStatus({
      codexCommand: trimString(state.settings.codexCommand, "codex")
    });
  } catch (error) {
    codexStatus = {
      installed: false,
      loggedIn: false,
      authMode: "none",
      accountLabel: "Not signed in",
      providerLabel: "",
      statusText: `Status check failed: ${error.message || String(error)}`
    };
  } finally {
    codexStatusLoading = false;
    renderCodexStatus();
    renderBusyState();
    renderSidebarAccount(getCurrentSession());
  }
}

function addSession() {
  const session = createNewSession();
  state.sessions.unshift(session);
  state.currentSessionId = session.id;
  pendingImages = [];
  workspaceChanges = [];
  workspaceChangesTotals = { additions: 0, deletions: 0 };
  workspaceChangesMessage = "Select a workspace folder to view git changes.";
  workspaceChangesLoading = false;
  clearSelectedChangeView();
  setStatus("Ready");
  render();
  queueSave();
}

function removeSession(sessionId) {
  if (state.sessions.length === 1) {
    const session = createNewSession();
    state.sessions = [session];
    state.currentSessionId = session.id;
    pendingImages = [];
    workspaceChanges = [];
    workspaceChangesTotals = { additions: 0, deletions: 0 };
    workspaceChangesMessage = "Select a workspace folder to view git changes.";
    workspaceChangesLoading = false;
    clearSelectedChangeView();
    setStatus("Ready");
    render();
    queueSave();
    return;
  }
  state.sessions = state.sessions.filter((session) => session.id !== sessionId);
  if (!state.sessions.some((session) => session.id === state.currentSessionId)) {
    state.currentSessionId = state.sessions[0].id;
  }
  pendingImages = [];
  setStatus("Ready");
  refreshWorkspaceChanges();
  render();
  queueSave();
}

function switchSession(sessionId) {
  if (!state.sessions.some((session) => session.id === sessionId)) {
    return;
  }
  state.currentSessionId = sessionId;
  pendingImages = [];
  setStatus("Ready");
  render();
  refreshWorkspaceChanges();
  queueSave();
}

function markConversationTitle(session, prompt) {
  if (!session.messages.length || session.title === "New Chat") {
    session.title = prompt.slice(0, 56);
  }
}

function formatFailedRun(result) {
  if (result && result.notInstalled) {
    return [
      `Codex command was not found: ${trimString(state.settings.codexCommand, "codex")}`,
      "Install and login, then click Refresh Status:",
      "npm install -g @openai/codex",
      "codex login"
    ].join("\n");
  }

  if (result && typeof result.assistantText === "string" && result.assistantText.trim()) {
    return result.assistantText.trim();
  }

  const lines = [];
  if (result && typeof result.stderr === "string" && result.stderr.trim()) {
    lines.push(result.stderr.trim());
  }
  if (result && typeof result.stdout === "string" && result.stdout.trim()) {
    lines.push(result.stdout.trim());
  }
  if (!lines.length) {
    lines.push(
      `Codex command failed${result && result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}.`
    );
  }
  return lines.join("\n");
}

function formatSuccessfulRun(result) {
  if (result && typeof result.assistantText === "string" && result.assistantText.trim()) {
    return result.assistantText.trim();
  }
  if (result && typeof result.stdout === "string" && result.stdout.trim()) {
    return result.stdout.trim();
  }
  if (result && typeof result.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }
  if (result && Array.isArray(result.commandLog) && result.commandLog.length) {
    return "Completed. See commands run below.";
  }
  if (result && Array.isArray(result.terminalLog) && result.terminalLog.length) {
    return "Completed. See terminal output below.";
  }
  return [
    "Codex completed but returned no visible text.",
    "Click Refresh, confirm Codex login/network, then retry."
  ].join("\n");
}

function formatCancelledRun(result) {
  if (result && typeof result.assistantText === "string" && result.assistantText.trim()) {
    return `${result.assistantText.trim()}\n\nStopped by user.`;
  }
  return "Stopped by user.";
}

function shouldRetryBlockedPolicy(result) {
  if (!result || typeof result !== "object" || result.ok) {
    return false;
  }
  const combined = [
    typeof result.assistantText === "string" ? result.assistantText : "",
    typeof result.stderr === "string" ? result.stderr : "",
    typeof result.stdout === "string" ? result.stdout : ""
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return combined.includes("blocked by policy");
}

function resolveRetryApprovalPolicy(approvalPolicy) {
  const current = trimString(approvalPolicy, DEFAULT_APPROVAL).toLowerCase();
  if (current === "untrusted") {
    return "untrusted";
  }
  return "never";
}

function appendBlockedPolicyHint(result, approvalPolicy) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const current = trimString(approvalPolicy, DEFAULT_APPROVAL).toLowerCase();
  if (current !== "untrusted") {
    return result;
  }

  const hint =
    'Approval mode is set to "No, Suggest Something Else" (untrusted), which blocks command execution. Switch Approval to "Yes Yes and Allow" and retry.';
  const stderr = typeof result.stderr === "string" && result.stderr.trim() ? `${result.stderr}\n${hint}` : hint;
  return {
    ...result,
    stderr
  };
}

function buildExecutionPrompt(userPrompt) {
  const instruction = [
    "Execution rules:",
    "- Actually execute required terminal commands; do not only describe them.",
    "- Use Windows command syntax only. Never use single-quoted command payloads.",
    "- Do not use `cmd.exe /c` for normal commands; run them directly (`echo test`, `dir`, `npm run dev`).",
    "- Do not nest `cmd.exe /c` inside another `cmd.exe /c`; run direct commands like `dir`, `echo test`, `npm run build`, etc.",
    "- If you start a local server, run it in the background on Windows and verify it is reachable before saying it is ready.",
    "- Do not use certutil, bitsadmin, or similar download utilities for localhost checks.",
    "- Prefer safe local verification (PowerShell Invoke-WebRequest or Node HTTP request) and report the exact command output.",
    "- If any command fails, report the stderr and fix it."
  ].join("\n");

  return `${instruction}\n\nUser request:\n${userPrompt}`;
}

async function sendPromptWithTimeout(payload, timeoutMs = CODEX_RUN_TIMEOUT_MS) {
  let timer = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (payload && typeof payload.requestId === "string" && payload.requestId.trim()) {
          window.codexDesktop.cancelPrompt(payload.requestId).catch(() => {
            // no-op
          });
        }
        reject(new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
    });

    return await Promise.race([window.codexDesktop.sendPrompt(payload), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function addPendingImages(imagePaths) {
  const merged = new Set(pendingImages);
  for (const imagePath of imagePaths) {
    if (typeof imagePath === "string" && imagePath.trim()) {
      merged.add(imagePath);
    }
  }
  pendingImages = Array.from(merged);
  renderAttachments();
}

async function sendPrompt() {
  const session = getCurrentSession();
  if (!session || activeRequestId) {
    return;
  }

  const prompt = promptInput.value.trim();
  if (!prompt) {
    return;
  }

  if (codexStatus && codexStatus.installed === false) {
    setStatus("Codex is not installed. Use Refresh Status panel.");
    renderCodexStatus();
    return;
  }

  if (codexStatus && codexStatus.loggedIn === false) {
    setStatus("Codex login required. Run `codex login`, then Refresh Status.");
    renderCodexStatus();
    return;
  }

  const approvalPolicy = resolveApproval(session);

  const promptForCodex = buildExecutionPrompt(prompt);

  const images = [...pendingImages];
  pendingImages = [];

  const userMessage = {
    id: uid(),
    role: "user",
    text: prompt,
    commands: [],
    terminalLog: [],
    usage: sanitizeUsage(null),
    images,
    error: false,
    pending: false,
    timestamp: now()
  };

  const assistantMessage = {
    id: uid(),
    role: "assistant",
    text: "Running Codex...",
    commands: [],
    terminalLog: [],
    usage: sanitizeUsage(null),
    images: [],
    error: false,
    pending: true,
    timestamp: now()
  };

  session.messages.push(userMessage, assistantMessage);
  markConversationTitle(session, prompt);
  session.updatedAt = now();

  promptInput.value = "";
  const requestId = uid();
  const requestIdsForTurn = new Set([requestId]);
  activeRequestId = requestId;
  startRunStatusTimer("Running Codex...");
  render();
  queueSave();

  try {
    const basePayload = {
      requestId,
      codexCommand: trimString(state.settings.codexCommand, "codex"),
      sessionThreadId: trimString(session.threadId, ""),
      prompt: promptForCodex,
      model: resolveModel(session),
      reasoningEffort: resolveReasoning(session),
      approvalPolicy,
      images,
      workspaceDir: trimString(session.workspaceDir, "")
    };
    let result = await sendPromptWithTimeout(basePayload);

    const targetSession = state.sessions.find((candidate) => candidate.id === session.id);
    if (!targetSession) {
      stopRunStatusTimer();
      setStatus("Ready");
      return;
    }

    if (!result.cancelled && shouldRetryBlockedPolicy(result)) {
      const retryApprovalPolicy = resolveRetryApprovalPolicy(approvalPolicy);
      if (retryApprovalPolicy === "untrusted") {
        result = appendBlockedPolicyHint(result, approvalPolicy);
      } else {
        const retryRequestId = uid();
        requestIdsForTurn.add(retryRequestId);
        activeRequestId = retryRequestId;
        setRunStatusPrefix("Retrying Codex...");
        const retryPrompt = [
          promptForCodex,
          "",
          "Retry rule:",
          "- Previous attempt was blocked by policy.",
          `- Override approval policy to "${retryApprovalPolicy}" for this retry.`,
          "- Start a fresh execution thread for this attempt.",
          "- Run Windows commands directly and avoid single-quoted cmd payloads."
        ].join("\n");

        const retryResult = await sendPromptWithTimeout({
          ...basePayload,
          requestId: retryRequestId,
          approvalPolicy: retryApprovalPolicy,
          sessionThreadId: "",
          prompt: retryPrompt
        });

        if (retryResult && typeof retryResult === "object") {
          result = retryResult;
        }
      }
    }

    if (typeof result.threadId === "string" && result.threadId.trim()) {
      targetSession.threadId = result.threadId.trim();
    }

    if (result.notInstalled) {
      codexStatus = {
        installed: false,
        loggedIn: false,
        authMode: "none",
        accountLabel: "Not signed in",
        providerLabel: "",
        statusText: "Codex command not found."
      };
      renderCodexStatus();
    }

    assistantMessage.pending = false;
    assistantMessage.commands = Array.isArray(result.commandLog)
      ? result.commandLog.filter((command) => typeof command === "string" && command.trim())
      : [];
    assistantMessage.terminalLog = Array.isArray(result.terminalLog)
      ? result.terminalLog.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    assistantMessage.usage = sanitizeUsage(result ? result.usage : null);
    if (result.cancelled) {
      assistantMessage.error = false;
      assistantMessage.text = formatCancelledRun(result);
    } else if (result.ok) {
      assistantMessage.text = formatSuccessfulRun(result);
      if (
        (!result.assistantText || !result.assistantText.trim()) &&
        (!assistantMessage.commands || !assistantMessage.commands.length) &&
        (!assistantMessage.terminalLog || !assistantMessage.terminalLog.length)
      ) {
        assistantMessage.error = true;
      }
    } else {
      assistantMessage.error = true;
      assistantMessage.text = formatFailedRun(result);
    }
    assistantMessage.timestamp = now();
    targetSession.updatedAt = now();

    stopRunStatusTimer();
    setStatus(result.cancelled ? "Stopped" : result.ok ? "Ready" : "Codex reported an error");
  } catch (error) {
    const errorMessage = error && error.message ? error.message : String(error);
    const timedOut = /timed out/i.test(errorMessage);
    assistantMessage.pending = false;
    assistantMessage.error = true;
    assistantMessage.text = timedOut
      ? `Codex took too long and was stopped.\n${errorMessage}`
      : `Failed to start Codex command.\n${errorMessage}`;
    assistantMessage.timestamp = now();
    stopRunStatusTimer();
    setStatus(timedOut ? "Codex timed out" : "Failed to start Codex");
  } finally {
    if (activeRequestId && requestIdsForTurn.has(activeRequestId)) {
      activeRequestId = null;
    }
    stopRunStatusTimer();
    await refreshWorkspaceChanges();
    render();
    queueSave();
  }
}

async function cancelPrompt() {
  if (!activeRequestId) {
    return;
  }
  setRunStatusPrefix("Stopping Codex...");
  try {
    const cancelResult = await window.codexDesktop.cancelPrompt(activeRequestId);
    const didCancel =
      cancelResult === true ||
      (cancelResult && typeof cancelResult === "object" && cancelResult.ok === true);
    if (!didCancel) {
      setStatus("Unable to stop Codex (already finished).");
    }
  } catch (error) {
    console.error("Failed to cancel Codex:", error);
    setStatus("Failed to stop Codex process.");
  }
}

async function pickImages() {
  if (activeRequestId) {
    return;
  }
  const selected = await window.codexDesktop.pickImages();
  if (!Array.isArray(selected) || !selected.length) {
    return;
  }
  addPendingImages(selected);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read clipboard image."));
    reader.readAsDataURL(file);
  });
}

async function addClipboardImage(file) {
  if (!file) {
    return null;
  }

  if (typeof file.path === "string" && file.path.trim()) {
    return file.path;
  }

  const dataUrl = await fileToDataUrl(file);
  const savedPath = await window.codexDesktop.savePastedImage(dataUrl);
  return savedPath;
}

async function handlePaste(event) {
  if (activeRequestId || !event.clipboardData) {
    return;
  }

  const items = Array.from(event.clipboardData.items || []);
  const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!imageItems.length) {
    return;
  }

  event.preventDefault();
  const newPaths = [];

  for (const item of imageItems) {
    try {
      const file = item.getAsFile();
      const nextPath = await addClipboardImage(file);
      if (nextPath) {
        newPaths.push(nextPath);
      }
    } catch (error) {
      console.error("Failed to paste image:", error);
    }
  }

  if (newPaths.length) {
    addPendingImages(newPaths);
    setStatus(`Attached ${newPaths.length} pasted image${newPaths.length > 1 ? "s" : ""}.`);
  }
}

async function openWorkspaceFolder() {
  if (activeRequestId) {
    return;
  }
  const selectedFolder = await window.codexDesktop.pickFolder();
  if (!selectedFolder) {
    return;
  }
  const session = getCurrentSession();
  if (!session) {
    return;
  }
  session.workspaceDir = selectedFolder;
  session.threadId = "";
  session.updatedAt = now();
  await refreshWorkspaceChanges();
  render();
  queueSave();
}

function clearWorkspaceFolder() {
  if (activeRequestId) {
    return;
  }
  const session = getCurrentSession();
  if (!session) {
    return;
  }
  session.workspaceDir = "";
  session.threadId = "";
  session.updatedAt = now();
  workspaceChanges = [];
  workspaceChangesTotals = { additions: 0, deletions: 0 };
  workspaceChangesMessage = "Select a workspace folder to view git changes.";
  workspaceChangesLoading = false;
  clearSelectedChangeView();
  render();
  queueSave();
}

function bindEvents() {
  window.addEventListener("resize", () => {
    scrollMessagesToBottom(false);
  });

  newChatBtn.addEventListener("click", () => {
    addSession();
    refreshWorkspaceChanges();
  });

  sessionList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const deleteId = target.dataset.deleteSessionId;
    if (deleteId) {
      removeSession(deleteId);
      return;
    }

    const row = target.closest(".session-item");
    if (!row || !row.dataset.sessionId) {
      return;
    }
    switchSession(row.dataset.sessionId);
  });

  changesList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const card = target.closest(".change-card");
    if (!card) {
      return;
    }
    const nextPath = trimString(card.dataset.changePath, "");
    if (!nextPath) {
      return;
    }

    selectedChangePath = nextPath;
    selectedChangeView = {
      path: nextPath,
      loading: true,
      error: "",
      text: "",
      truncated: false
    };
    renderWorkspaceChanges();
    loadSelectedChangeCode(nextPath);
  });

  modelSelect.addEventListener("change", () => {
    const session = getCurrentSession();
    if (!session) {
      return;
    }
    session.model = normalizeModelProfile(modelSelect.value);
    const profile = getProfile(session);
    if (profile && profile.defaultReasoning) {
      session.reasoningEffort = profile.defaultReasoning;
    }
    renderReasoningApprovalControls(session);
    queueSave();
  });

  reasoningSelect.addEventListener("change", () => {
    const session = getCurrentSession();
    if (!session) {
      return;
    }
    session.reasoningEffort = reasoningSelect.value;
    queueSave();
  });

  approvalSelect.addEventListener("change", () => {
    const session = getCurrentSession();
    if (!session) {
      return;
    }
    session.approvalPolicy = approvalSelect.value;
    queueSave();
  });

  codexCommandInput.addEventListener("input", () => {
    state.settings.codexCommand = trimString(codexCommandInput.value, "codex");
    codexStatus = null;
    renderCodexStatus();
    queueSave();
  });

  refreshStatusBtn.addEventListener("click", refreshCodexStatus);
  openFolderBtn.addEventListener("click", openWorkspaceFolder);
  clearFolderBtn.addEventListener("click", clearWorkspaceFolder);
  attachImageBtn.addEventListener("click", pickImages);
  sendBtn.addEventListener("click", sendPrompt);
  cancelBtn.addEventListener("click", cancelPrompt);

  attachmentList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const indexText = target.dataset.removeAttachmentIndex;
    if (indexText === undefined) {
      return;
    }
    const index = Number.parseInt(indexText, 10);
    if (!Number.isInteger(index) || index < 0 || index >= pendingImages.length) {
      return;
    }
    pendingImages.splice(index, 1);
    renderAttachments();
  });

  promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  });

  promptInput.addEventListener("paste", (event) => {
    handlePaste(event).catch((error) => {
      console.error("Paste handling failed:", error);
    });
  });
}

async function bootstrap() {
  setStatus("Loading...");
  const loaded = await window.codexDesktop.loadState();
  state = sanitizeState(loaded);
  primeAssistantTypingState();
  bindEvents();
  render();
  await Promise.all([refreshWorkspaceChanges(), refreshCodexStatus()]);
  setStatus("Ready");
  hideStartupSplash();
}

bootstrap().catch((error) => {
  console.error("Failed to initialize renderer:", error);
  setStatus("Failed to initialize");
  hideStartupSplash();
});
