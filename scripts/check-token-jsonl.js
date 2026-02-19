const fs = require("fs");
const path = require("path");

function extractTokenCountInfo(record, seen = new Set()) {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (seen.has(record)) {
    return null;
  }
  seen.add(record);

  const hasTokenUsage = Object.prototype.hasOwnProperty.call(record, "last_token_usage");
  const hasRateLimits = Object.prototype.hasOwnProperty.call(record, "rate_limits");
  if (hasTokenUsage || hasRateLimits) {
    return record;
  }

  if (
    typeof record.type === "string" &&
    record.type.toLowerCase() === "token_count" &&
    record.info &&
    typeof record.info === "object"
  ) {
    return record.info;
  }

  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nestedInfo = extractTokenCountInfo(item, seen);
        if (nestedInfo) {
          return nestedInfo;
        }
      }
      continue;
    }

    const nestedInfo = extractTokenCountInfo(value, seen);
    if (nestedInfo) {
      return nestedInfo;
    }
  }

  return null;
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/check-token-jsonl.js <path>");
  process.exit(1);
}

const resolvedPath = path.resolve(inputPath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`File not found: ${resolvedPath}`);
  process.exit(1);
}

const text = fs.readFileSync(resolvedPath, "utf8");
const lines = text.split(/\r?\n/g);
let tokenCountEvents = 0;
let lastInfo = null;
let rateLimitEvents = 0;
let lastWithRateLimits = null;

for (const line of lines) {
  if (!line.trim()) {
    continue;
  }

  let record = null;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }

  const info = extractTokenCountInfo(record);
  if (info) {
    tokenCountEvents += 1;
    lastInfo = info;
    if (info.rate_limits && typeof info.rate_limits === "object") {
      rateLimitEvents += 1;
      lastWithRateLimits = info;
    }
  }
}

console.log(`token_count events: ${tokenCountEvents}`);
console.log(`token_count with rate_limits: ${rateLimitEvents}`);

if (!lastInfo) {
  process.exit(0);
}

const summaryInfo = lastWithRateLimits || lastInfo;
console.log(
  JSON.stringify(
    {
      lastTokenUsage: summaryInfo.last_token_usage || null,
      primaryRateLimit:
        summaryInfo.rate_limits && summaryInfo.rate_limits.primary
          ? summaryInfo.rate_limits.primary
          : null,
      secondaryRateLimit:
        summaryInfo.rate_limits && summaryInfo.rate_limits.secondary
          ? summaryInfo.rate_limits.secondary
          : null
    },
    null,
    2
  )
);
