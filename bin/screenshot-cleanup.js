#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const readline = require("readline");
const { pathToFileURL } = require("url");

const APP_NAME = "screenshot-cleanup";
const WINDOWS_DEFAULT_FOLDER = path.join(os.homedir(), "Pictures", "Screenshots");
const DEFAULT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];
const SSC_IMPORTANT_ATTR = "ssc_important";

const DEFAULT_CONFIG = {
  defaultFolder:
    process.platform === "win32"
      ? WINDOWS_DEFAULT_FOLDER
      : path.join(os.homedir(), "Pictures", "Screenshots"),
  recursive: false,
  includeHidden: false,
  extensions: DEFAULT_EXTENSIONS,
  maxFilesPerRun: 250,
  sortOrder: "newest",
  minFileSizeKB: 10,
  cacheEnabled: true,
  maxConcurrency: 4,
  requestTimeoutMs: 60000,
  provider: "codex",
  providers: {
    codex: {
      enabled: true,
      command: "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "{model}",
        "--image",
        "{image}",
        "-"
      ],
      model: "gpt-4.1-mini",
      promptMode: "stdin",
      outputJsonPath: ""
    },
    copilot: {
      enabled: false,
      command: "copilot",
      args: [
        "chat",
        "--yolo",
        "--model",
        "{model}",
        "--image",
        "{image}",
        "--json",
        "{prompt}"
      ],
      model: "gpt-4.1",
      fallbackToCodex: false,
      outputJsonPath: ""
    }
  },
  promptTemplate:
    [
      "Classify screenshot importance for cleanup.",
      "Return strict JSON only with keys:",
      "{\"important\":boolean,\"confidence\":number,\"reason\":string}",
      "Important=true for unique work artifacts: code, errors, receipts, docs, instructions, account or transaction proof.",
      "Important=false for duplicates, temporary UI states, low-value browsing, blank/near-blank shots, memes, or accidental captures.",
      "Keep reason under 80 chars."
    ].join("\n"),
  importanceThreshold: 0.65,
  action: "report",
  quarantineDir: "",
  daily: {
    enabled: true,
    maxFilesPerRun: 20,
    maxModelCallsPerDay: 8,
    maxActionsPerDay: 8,
    sortOrder: "oldest",
    action: "move"
  },
  installer: {
    codexDir:
      process.platform === "win32"
        ? path.join(os.homedir(), ".codex")
        : path.join(os.homedir(), ".codex"),
    copilotDir:
      process.platform === "win32"
        ? path.join(os.homedir(), ".copilot")
        : path.join(os.homedir(), ".copilot"),
    scriptBaseName: "screenshot-cleanup-daily",
    installTarget: "both",
    defaultProviderForCodex: "codex",
    defaultProviderForCopilot: "copilot"
  }
};

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

function supportsColor() {
  if (process.env.NO_COLOR) return false;
  const force = String(process.env.FORCE_COLOR || "").trim();
  if (force === "0") return false;
  if (force) return true;
  if (!process.stdout || !process.stdout.isTTY) return false;
  if (process.platform !== "win32") return true;
  return Boolean(
    process.env.WT_SESSION ||
      process.env.ANSICON ||
      process.env.ConEmuANSI === "ON" ||
      String(process.env.TERM_PROGRAM || "").toLowerCase().includes("vscode")
  );
}

function paint(text, colorCode) {
  if (!supportsColor()) return String(text);
  return `${colorCode}${text}${ANSI.reset}`;
}

function labelInfo(text) {
  return paint(text, ANSI.cyan);
}

function labelOk(text) {
  return paint(text, ANSI.green);
}

function labelWarn(text) {
  return paint(text, ANSI.yellow);
}

function labelErr(text) {
  return paint(text, ANSI.red);
}

function labelDim(text) {
  return paint(text, ANSI.dim);
}

function getTerminalColumns() {
  const cols = Number(process.stdout?.columns || 0);
  if (Number.isFinite(cols) && cols >= 40) return cols;
  return 120;
}

function wrapTextLines(text, width) {
  const maxWidth = Math.max(20, Number(width) || 80);
  const input = String(text || "");
  const paragraphs = input.split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const next = words[i];
      if (`${current} ${next}`.length <= maxWidth) {
        current = `${current} ${next}`;
      } else {
        lines.push(current);
        if (next.length > maxWidth) {
          let rest = next;
          while (rest.length > maxWidth) {
            lines.push(rest.slice(0, maxWidth));
            rest = rest.slice(maxWidth);
          }
          current = rest;
        } else {
          current = next;
        }
      }
    }
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

function printWrappedReason(reason, colorize) {
  const indent = "   ";
  const width = getTerminalColumns() - indent.length;
  const lines = wrapTextLines(reason, width);
  for (const line of lines) {
    const rendered = colorize ? colorize(line) : line;
    console.log(`${indent}${rendered}`);
  }
}

function formatProviderCmdArgsForDisplay(args) {
  const out = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push("<prompt>");
      hideNext = false;
      continue;
    }
    const token = String(arg);
    if (token === "-p" || token === "--prompt") {
      out.push(token);
      hideNext = true;
      continue;
    }
    out.push(token);
  }
  return out;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        args[token.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        args[token.slice(2)] = true;
      }
    } else if (token.startsWith("-")) {
      args[token.slice(1)] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function printHelp(configPath) {
  const config = await loadConfig(configPath);
  console.log(`Usage:
  ssc --install
  ssc --uninstall
  ssc init [--config <path>]
  ssc run [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
          [--max-files <n>] [--min-size-kb <n>] [--threshold <0-1>] [--concurrency <n>]
          [--oldest-first|--newest-first] [--aggressive]
          [--force] [--yes] [--verbose] [--config <path>]
  ssc run-daily [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
                [--max-files <n>] [--oldest-first|--newest-first] [--aggressive] [--verbose] [--config <path>]
  ssc schedule install [--time <HH:mm>] [--task-name <name>] [--folder <path>]
                       [--provider codex|copilot] [--model <name>] [--action report|move|delete]
                       [--max-files <n>] [--oldest-first|--newest-first] [--aggressive] [--verbose]
                       [--start-day auto|today|tomorrow] [--config <path>]
  ssc schedule status [--task-name <name>]
  ssc schedule run-now [--task-name <name>]
  ssc schedule uninstall [--task-name <name>]
  ssc install [--target codex|copilot|both]
              [--codex-dir <path>] [--copilot-dir <path>]
              [--script-name <name>] [--force] [--no-prompt] [--config <path>]
  ssc uninstall [--target codex|copilot|both]
                [--codex-dir <path>] [--copilot-dir <path>]
                [--script-name <name>] [--clear-manifest] [--no-prompt] [--config <path>]
  ssc config get [--config <path>]
  ssc config set <key> <value> [--config <path>]
  ssc help

Notes:
  - Default Windows folder: C:\\Users\\<you>\\Pictures\\Screenshots
  - Configure provider command/args in config to match your local Codex/Copilot CLI syntax.
  - Results are cached by file path + mtime + size to minimize repeated model requests.

Current effective config (${configPath}):
${JSON.stringify(config, null, 2)}`);
}

function parsePrimitive(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }
  return value;
}

function getConfigDir() {
  if (process.env.SSC_CONFIG_DIR) return process.env.SSC_CONFIG_DIR;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_NAME);
  }
  return path.join(os.homedir(), ".config", APP_NAME);
}

function getConfigPath(override) {
  if (override) return path.resolve(override);
  return path.join(getConfigDir(), "config.json");
}

function getCachePath(configPath) {
  return path.join(path.dirname(configPath), "cache.json");
}

function getDailyStatePath(configPath) {
  return path.join(path.dirname(configPath), "daily-state.json");
}

function getDefaultScheduleTaskName() {
  return "SSC Screenshot Cleanup Daily";
}

function mergeConfig(base, override) {
  const merged = { ...base, ...override };
  merged.providers = {
    ...base.providers,
    ...(override.providers || {})
  };
  for (const key of Object.keys(merged.providers)) {
    merged.providers[key] = {
      ...(base.providers[key] || {}),
      ...(merged.providers[key] || {})
    };
  }
  return merged;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
}

async function loadConfig(configPath) {
  const fileConfig = await readJson(configPath, {});
  return mergeConfig(DEFAULT_CONFIG, fileConfig);
}

function setByPath(target, key, value) {
  const parts = key.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") {
      cursor[parts[i]] = {};
    }
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

function normalizeExtensions(exts) {
  if (!Array.isArray(exts)) return DEFAULT_EXTENSIONS;
  const normalized = exts
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  return Array.from(new Set(normalized));
}

async function listFiles(dir, options) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!options.includeHidden && entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (options.recursive) {
        const nested = await listFiles(fullPath, options);
        out.push(...nested);
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!options.extensions.includes(ext)) continue;
    out.push(fullPath);
  }
  return out;
}

async function fileMeta(filePath) {
  const st = await fs.stat(filePath);
  return {
    filePath,
    size: st.size,
    mtimeMs: st.mtimeMs
  };
}

function cacheKey(meta) {
  return `${meta.filePath}|${Math.trunc(meta.mtimeMs)}|${meta.size}`;
}

// Spawn a command and capture its stdout, rejecting on non-zero exit.
function spawnCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exit ${code}`));
    });
    child.on("error", reject);
  });
}

// Read ssc_important flag from file metadata (NTFS ADS on Windows, xattr on macOS, getfattr on Linux).
async function readFileImportantMeta(filePath) {
  try {
    if (process.platform === "win32") {
      const val = await fs.readFile(`${filePath}:${SSC_IMPORTANT_ATTR}`, "utf8");
      return val.trim() === "true";
    } else if (process.platform === "darwin") {
      const val = await spawnCapture("xattr", ["-p", SSC_IMPORTANT_ATTR, filePath]);
      return val === "true";
    } else {
      const val = await spawnCapture("getfattr", ["-n", `user.${SSC_IMPORTANT_ATTR}`, "--only-values", "--absolute-names", filePath]);
      return val === "true";
    }
  } catch {
    return false;
  }
}

// Write ssc_important=true to file metadata. Best-effort — never throws.
async function writeFileImportantMeta(filePath) {
  try {
    if (process.platform === "win32") {
      await fs.writeFile(`${filePath}:${SSC_IMPORTANT_ATTR}`, "true", "utf8");
    } else if (process.platform === "darwin") {
      await spawnCapture("xattr", ["-w", SSC_IMPORTANT_ATTR, "true", filePath]);
    } else {
      await spawnCapture("setfattr", ["-n", `user.${SSC_IMPORTANT_ATTR}`, "-v", "true", filePath]);
    }
  } catch {
    // Silently ignore — metadata write is best-effort
  }
}

function fillTemplate(tokens, values) {
  return tokens.map((token) => token.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? "")));
}

function withTimeout(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.on("error", () => {
          try {
            child.kill("SIGKILL");
          } catch (_) {
            // best-effort only
          }
        });
      } else {
        try {
          child.kill("SIGKILL");
        } catch (_) {
          // best-effort only
        }
      }
      reject(new Error(`Provider timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => clearTimeout(timer));
  });
}

function extractFirstJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Continue and try embedded JSON objects.
  }

  // Scan for the first parsable JSON object; skip malformed brace blocks.
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;
    let depth = 0;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth < 0) break;
      }
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (_) {
          break;
        }
      }
    }
  }
  return null;
}

function extractCopilotAssistantJson(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let lastAssistantContent = "";
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const evt = JSON.parse(line);
      if (evt?.type === "assistant.message" && typeof evt?.data?.content === "string") {
        lastAssistantContent = evt.data.content;
      }
    } catch (_) {
      // ignore non-JSON lines
    }
  }
  if (!lastAssistantContent) return null;
  return extractFirstJson(lastAssistantContent);
}

function heuristicClassificationFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const attachmentMissing =
    lower.includes("no screenshot attached") ||
    lower.includes("no screenshot") ||
    lower.includes("no image attached") ||
    lower.includes("no image provided") ||
    lower.includes("don't see a screenshot attached") ||
    lower.includes("message was cut off") ||
    lower.includes("message was truncated") ||
    lower.includes("message may be incomplete");
  if (attachmentMissing) {
    return null;
  }
  const looksLikeToolTrace =
    lower.includes("search (glob)") ||
    lower.includes("list directory") ||
    lower.includes("toolrequests") ||
    lower.includes("\"type\":\"assistant.message_delta\"") ||
    lower.includes("\"type\":\"assistant.message\"");
  if (looksLikeToolTrace) {
    return null;
  }
  const strongKeep =
    lower.includes("receipt") ||
    lower.includes("invoice") ||
    lower.includes("error") ||
    lower.includes("stack trace") ||
    lower.includes("policy") ||
    lower.includes("rejection notice") ||
    lower.includes("transaction") ||
    lower.includes("confirmation");
  const disposableSignals =
    lower.includes("temporary") ||
    lower.includes("ui state") ||
    lower.includes("low-value") ||
    lower.includes("accidental") ||
    lower.includes("duplicate");
  const important = strongKeep ? true : disposableSignals ? false : true;
  const confidence = strongKeep || disposableSignals ? 0.7 : 0.3;
  const reason = raw.slice(0, 120) || (important ? "Heuristic keep from provider text output" : "Heuristic dispose from provider text output");
  return { important, confidence, reason };
}

function normalizeClassification(data) {
  if (!data || typeof data !== "object") return null;
  let important = data.important;
  if (typeof important === "string") {
    const v = important.trim().toLowerCase();
    if (v === "true") important = true;
    else if (v === "false") important = false;
    else return null;
  }
  if (typeof important !== "boolean") return null;
  const confidenceRaw = Number(data.confidence);
  if (!Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const reason = String(data.reason ?? "").slice(0, 160);
  return { important, confidence, reason, raw: data };
}

function isUnusableCopilotReason(reason) {
  const lower = String(reason || "").toLowerCase();
  return (
    lower.includes("don't see a screenshot") ||
    lower.includes("no screenshot attached") ||
    lower.includes("no screenshot") ||
    lower.includes("no image attached") ||
    lower.includes("no image provided") ||
    lower.includes("message was cut off") ||
    lower.includes("message was truncated") ||
    lower.includes("additional details were included") ||
    lower.includes("additional details were provided") ||
    lower.includes("could you provide") ||
    lower.includes("message may be incomplete")
  );
}

function shouldFallbackCopilotToCodex(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("could not parse json") ||
    msg.includes("unknown option '--image'") ||
    msg.includes("provider timeout") ||
    msg.includes("no screenshot attached") ||
    msg.includes("no screenshot") ||
    msg.includes("no image attached") ||
    msg.includes("no image provided") ||
    msg.includes("message was cut off") ||
    msg.includes("message was truncated") ||
    msg.includes("message may be incomplete")
  );
}

function getByPath(obj, pathExpr) {
  if (!pathExpr) return obj;
  const parts = pathExpr.split(".").filter(Boolean);
  let cursor = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function makePrompt(basePrompt, aggressive) {
  if (!aggressive) return basePrompt;
  return [
    String(basePrompt || "").trim(),
    "Aggressive cleanup mode:",
    "- Be conservative about keeping files; when unsure, mark important=false.",
    "- Error dialogs, broken paths, blank/near-blank shots, and transient app states are disposable.",
    "- Keep strict JSON output only."
  ].join("\n");
}

function getCopilotCompatTimeoutMs(config) {
  const base = Number(config?.requestTimeoutMs || 30000);
  // Keep Copilot compatibility mode aligned with standard request timeout to avoid slow tail latency.
  return Math.max(1000, base);
}

function quoteCmdArg(value) {
  const text = String(value ?? "");
  if (!text.length) return "\"\"";
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function sanitizeTaskNameForFileName(taskName) {
  const raw = String(taskName || "").trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "default";
}

function getScheduleRunnerScriptPath(configPath, taskName) {
  const dir = path.dirname(configPath);
  const safeName = sanitizeTaskNameForFileName(taskName);
  return path.join(dir, `schedule-runner-${safeName}.cmd`);
}

async function writeScheduleRunnerScript(configPath, taskName, nodeExe, scriptPath, runArgs) {
  const runnerPath = getScheduleRunnerScriptPath(configPath, taskName);
  await ensureDir(path.dirname(runnerPath));
  const commandLine = [
    quoteCmdArg(nodeExe),
    quoteCmdArg(scriptPath),
    ...runArgs.map(quoteCmdArg)
  ].join(" ");
  const content = [
    "@echo off",
    "setlocal",
    `${commandLine}`,
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
  await fs.writeFile(runnerPath, content, "utf8");
  return runnerPath;
}

function getTaskNameVariants(taskName) {
  const raw = String(taskName || "").trim();
  if (!raw) return [raw];
  const variants = [];
  if (raw.startsWith("\\")) {
    variants.push(raw);
    variants.push(raw.slice(1));
  } else {
    variants.push(raw);
    variants.push(`\\${raw}`);
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

async function spawnSchtasksWithTaskName(prefixArgs, taskName, suffixArgs = []) {
  const variants = getTaskNameVariants(taskName);
  let last = null;
  for (const variant of variants) {
    const result = await spawnCapture("schtasks.exe", [...prefixArgs, variant, ...suffixArgs]);
    if (result.code === 0) return result;
    last = result;
  }
  return last || { code: 1, stdout: "", stderr: "unknown error" };
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: Number(code || 0), stdout, stderr }));
  });
}

async function runProvider(config, providerName, model, imagePath, prompt, verbose) {
  const provider = config.providers[providerName];
  if (!provider || !provider.enabled) {
    throw new Error(`Provider "${providerName}" is not enabled in config.`);
  }
  if (!provider.command || !Array.isArray(provider.args)) {
    throw new Error(`Provider "${providerName}" must define command + args array.`);
  }

  const finalArgs = fillTemplate(provider.args, {
    model: model || provider.model,
    image: imagePath,
    prompt
  });
  const displayArgsRaw = fillTemplate(provider.args, {
    model: model || provider.model,
    image: imagePath,
    prompt: "<prompt>"
  });
  const displayArgs = formatProviderCmdArgsForDisplay(displayArgsRaw);
  const preferCopilotCompat = providerName === "copilot" && finalArgs.includes("--image");
  const promptMode = provider.promptMode === "stdin" ? "stdin" : "arg";

  if (verbose && !preferCopilotCompat) {
    console.log("");
    console.log(`${labelInfo("provider cmd:")} ${provider.command} ${labelDim(displayArgs.join(" "))}`);
  }

  const commandText = String(provider.command || "");
  const isCmdScript = /\.(cmd|bat)$/i.test(commandText);
  const isPowerShellScript = /\.ps1$/i.test(commandText);
  const runOnce = (args, timeoutOverrideMs) => {
    let child;
    if (process.platform === "win32" && isCmdScript) {
      const cmdExe = process.env.ComSpec || "cmd.exe";
      child = spawn(cmdExe, ["/d", "/c", provider.command, ...args], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else if (process.platform === "win32" && isPowerShellScript) {
      child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", provider.command, ...args], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else {
      child = spawn(provider.command, args, {
        stdio: ["pipe", "pipe", "pipe"]
      });
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (promptMode === "stdin") {
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const waitForExit = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Provider exited with code ${code}: ${stderr.trim() || "no stderr"}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    const timeoutMs = Math.max(1, Number(timeoutOverrideMs || config.requestTimeoutMs));
    return Promise.race([waitForExit, withTimeout(child, timeoutMs)]);
  };

  function withCodexSkipRepoCheck(args) {
    const next = Array.isArray(args) ? [...args] : [];
    if (next.includes("--skip-git-repo-check")) return next;
    const execIndex = next.findIndex((x) => String(x).toLowerCase() === "exec");
    if (execIndex >= 0) {
      next.splice(execIndex + 1, 0, "--skip-git-repo-check");
      return next;
    }
    next.unshift("--skip-git-repo-check");
    return next;
  }

  function buildCopilotCompatArgs() {
    const absoluteImagePath = path.resolve(imagePath);
    const imageFileUrl = pathToFileURL(absoluteImagePath).href;
    const compatPrompt = [
      "Classify one local screenshot for cleanup.",
      `ImagePath=${absoluteImagePath}`,
      `ImageUrl=${imageFileUrl}`,
      "Read exactly that file before deciding.",
      "If file cannot be read output exactly:",
      "{\"important\":true,\"confidence\":0,\"reason\":\"provider_could_not_read_image\"}.",
      "Otherwise output strict JSON only with keys important,confidence,reason.",
      "important=true only for durable artifacts (code/errors/receipts/docs/proofs).",
      "Otherwise important=false. Keep reason under 80 chars."
    ].join(" ");
    const compatArgs = [
      "-p",
      compatPrompt,
      "--model",
      String(model || provider.model || "gpt-5-mini"),
      "--yolo",
      "--allow-all-paths",
      "--add-dir",
      path.dirname(absoluteImagePath),
      "--no-custom-instructions",
      "--output-format",
      "json"
    ];
    return compatArgs;
  }

  let stdout = "";
  if (preferCopilotCompat) {
    const compatArgs = buildCopilotCompatArgs();
    const compatDisplayArgs = formatProviderCmdArgsForDisplay(compatArgs);
    if (verbose) {
      console.log("");
      console.log(`${labelInfo("provider mode:")} Copilot compatibility mode (no --image)`);
      console.log(`${labelInfo("provider cmd:")} ${provider.command} ${labelDim(compatDisplayArgs.join(" "))}`);
    }
    const compatTimeoutMs = getCopilotCompatTimeoutMs(config);
    const res = await runOnce(compatArgs, compatTimeoutMs);
    stdout = res.stdout;
  } else {
  try {
    const res = await runOnce(finalArgs);
    stdout = res.stdout;
  } catch (error) {
    const commandLower = String(provider.command || "").toLowerCase();
    const canRetryForTrustCheck =
      (providerName === "codex" || commandLower.includes("codex")) &&
      String(error?.message || "").toLowerCase().includes("not inside a trusted directory");
    if (canRetryForTrustCheck) {
      const retryArgs = withCodexSkipRepoCheck(finalArgs);
      const retryDisplayArgs = withCodexSkipRepoCheck(displayArgs);
      if (verbose) {
        console.log("");
        console.log(`${labelWarn("provider retry:")} adding --skip-git-repo-check`);
        console.log(`${labelInfo("provider cmd:")} ${provider.command} ${labelDim(retryDisplayArgs.join(" "))}`);
      }
      const res = await runOnce(retryArgs);
      stdout = res.stdout;
    } else {
      const canRetryCopilotCompat =
        providerName === "copilot" &&
        String(error?.message || "").toLowerCase().includes("unknown option '--image'");
      if (!canRetryCopilotCompat) throw error;
      const compatArgs = buildCopilotCompatArgs();
      const compatDisplayArgs = formatProviderCmdArgsForDisplay(compatArgs);
      if (verbose) {
        console.log("");
        console.log(`${labelWarn("provider retry:")} Copilot compatibility mode (no --image)`);
        console.log(`${labelInfo("provider cmd:")} ${provider.command} ${labelDim(compatDisplayArgs.join(" "))}`);
      }
      const compatTimeoutMs = getCopilotCompatTimeoutMs(config);
      const res = await runOnce(compatArgs, compatTimeoutMs);
      stdout = res.stdout;
    }
  }
  }
  const copilotAssistantParsed = providerName === "copilot" ? extractCopilotAssistantJson(stdout) : null;
  const parsed = copilotAssistantParsed || extractFirstJson(stdout);
  const fallbackHeuristic = !parsed && providerName === "copilot"
    ? heuristicClassificationFromText(stdout)
    : null;
  const finalParsed = parsed || fallbackHeuristic;
  if (!finalParsed) {
    throw new Error(`Could not parse JSON from provider output: ${stdout.slice(0, 400)}`);
  }

  const data = getByPath(finalParsed, provider.outputJsonPath || "") || finalParsed;
  const normalized = normalizeClassification(data);
  if (!normalized) {
    throw new Error(`Invalid classification schema from provider output: ${JSON.stringify(data).slice(0, 260)}`);
  }
  if (providerName === "copilot" && isUnusableCopilotReason(normalized.reason)) {
    throw new Error(`Copilot returned unusable classification text: ${normalized.reason}`);
  }
  return normalized;
}

function validateTimeHHmm(value) {
  const text = String(value || "").trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
    throw new Error(`Invalid time "${value}". Use HH:mm (24h), e.g. 09:30`);
  }
  return text;
}

function parseHHmmToMinutes(time) {
  const [hours, minutes] = String(time).split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

function formatDateForSchtasks(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${month}/${day}/${year}`;
}

function resolveScheduleStartDate(time, startDayMode) {
  const mode = String(startDayMode || "auto").toLowerCase();
  if (!["auto", "today", "tomorrow"].includes(mode)) {
    throw new Error(`Invalid start day "${startDayMode}". Use auto, today, or tomorrow.`);
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (mode === "today") return start;
  if (mode === "tomorrow") {
    start.setDate(start.getDate() + 1);
    return start;
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = parseHHmmToMinutes(time);
  if (nowMinutes >= targetMinutes) {
    start.setDate(start.getDate() + 1);
  }
  return start;
}

function buildScheduleRunArgs(configPath, args) {
  const runArgs = ["run-daily", "--config", configPath];
  const folder = args.folder ? path.resolve(String(args.folder)) : "";
  if (folder) runArgs.push(folder);
  if (args.provider) runArgs.push("--provider", String(args.provider));
  if (args.model) runArgs.push("--model", String(args.model));
  if (args.action) runArgs.push("--action", String(args.action));
  if (args["max-files"] !== undefined) runArgs.push("--max-files", String(args["max-files"]));
  if (args["oldest-first"]) runArgs.push("--oldest-first");
  if (args["newest-first"]) runArgs.push("--newest-first");
  if (args.aggressive) runArgs.push("--aggressive");
  if (args.verbose) runArgs.push("--verbose");
  return runArgs;
}

async function commandSchedule(configPath, args) {
  if (process.platform !== "win32") {
    throw new Error("schedule command currently supports Windows only.");
  }
  const op = String(args._[1] || "status").toLowerCase();
  const taskName = String(args["task-name"] || getDefaultScheduleTaskName());

  if (op === "install") {
    const time = validateTimeHHmm(args.time || "09:00");
    const startDay = String(args["start-day"] || "auto");
    const startDate = resolveScheduleStartDate(time, startDay);
    const startDateText = formatDateForSchtasks(startDate);
    const config = await loadConfig(configPath);
    if (!config?.daily?.enabled) {
      config.daily = { ...(config.daily || {}), enabled: true };
      await writeJson(configPath, config);
      console.log(`Enabled daily mode in config: ${configPath}`);
    }
    const runArgs = buildScheduleRunArgs(configPath, args);
    const nodeExe = process.execPath;
    const scriptPath = path.resolve(__filename);
    const runnerPath = await writeScheduleRunnerScript(configPath, taskName, nodeExe, scriptPath, runArgs);
    const comspec = process.env.ComSpec || "cmd.exe";
    const taskRunCommand = `${quoteCmdArg(comspec)} /d /c ${quoteCmdArg(runnerPath)}`;
    const created = await spawnCapture("schtasks.exe", [
      "/Create",
      "/F",
      "/SC",
      "DAILY",
      "/TN",
      taskName,
      "/TR",
      taskRunCommand,
      "/ST",
      time,
      "/SD",
      startDateText
    ]);
    if (created.code !== 0) {
      throw new Error(`Failed to create scheduled task: ${created.stderr.trim() || created.stdout.trim() || "unknown error"}`);
    }
    console.log(`Scheduled task installed: ${taskName}`);
    console.log(`Time: ${time}`);
    console.log(`Start date: ${startDateText}`);
    console.log(`Runner script: ${runnerPath}`);
    console.log(`Command: ${taskRunCommand}`);
    return;
  }

  if (op === "status") {
    const queried = await spawnSchtasksWithTaskName(["/Query", "/TN"], taskName, ["/V", "/FO", "LIST"]);
    if (queried.code !== 0) {
      console.log(`Task not found: ${taskName}`);
      return;
    }
    console.log(queried.stdout.trim());
    return;
  }

  if (op === "run-now" || op === "run" || op === "now" || op === "runnow") {
    const started = await spawnSchtasksWithTaskName(["/Run", "/TN"], taskName);
    if (started.code !== 0) {
      throw new Error(`Failed to run scheduled task now: ${started.stderr.trim() || started.stdout.trim() || "unknown error"}`);
    }
    console.log(`Scheduled task started: ${taskName}`);
    return;
  }

  if (op === "uninstall" || op === "remove" || op === "delete") {
    const deleted = await spawnSchtasksWithTaskName(["/Delete", "/F", "/TN"], taskName);
    if (deleted.code !== 0) {
      throw new Error(`Failed to delete scheduled task: ${deleted.stderr.trim() || deleted.stdout.trim() || "unknown error"}`);
    }
    const runnerPath = getScheduleRunnerScriptPath(configPath, taskName);
    await fs.unlink(runnerPath).catch(() => {});
    console.log(`Scheduled task removed: ${taskName}`);
    return;
  }

  throw new Error(`Unknown schedule operation: ${op}. Use install, status, run-now, or uninstall.`);
}

async function runPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      out[current] = await worker(items[current], current);
    }
  }
  const workers = [];
  const count = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < count; i += 1) workers.push(runner());
  await Promise.all(workers);
  return out;
}

async function ensureUniquePath(targetPath) {
  try {
    await fs.access(targetPath);
  } catch (_) {
    return targetPath;
  }
  const parsed = path.parse(targetPath);
  for (let i = 1; i < 10000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.${i}${parsed.ext}`);
    try {
      await fs.access(candidate);
    } catch (_) {
      return candidate;
    }
  }
  throw new Error(`Could not find unique path for ${targetPath}`);
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dayKeyNow() {
  const dt = new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeTarget(value, fallback) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "codex" || v === "copilot" || v === "both") return v;
  return fallback;
}

function normalizeTargetWithAllowed(value, fallback, allowed) {
  const v = normalizeTarget(value, fallback);
  if (!Array.isArray(allowed) || !allowed.length) return v;
  return allowed.includes(v) ? v : fallback;
}

function normalizeProvider(value, fallback) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "codex" || v === "copilot") return v;
  return fallback;
}

function isFreeCopilotModel(modelName) {
  const normalized = String(modelName || "").trim().toLowerCase().replace(/\s+/g, "-");
  return normalized === "gpt-5-mini";
}

function normalizeProviderWithAllowed(value, fallback, allowed) {
  const v = normalizeProvider(value, fallback);
  if (!Array.isArray(allowed) || !allowed.length) return v;
  return allowed.includes(v) ? v : fallback;
}

function normalizeSort(value, fallback) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "oldest" || v === "newest") return v;
  return fallback;
}

function normalizeAction(value, fallback) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "report" || v === "move" || v === "delete") return v;
  return fallback;
}

function parseBooleanInput(value, fallback) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return fallback;
  if (["y", "yes", "true", "1"].includes(v)) return true;
  if (["n", "no", "false", "0"].includes(v)) return false;
  return fallback;
}

function parseNumberInput(value, fallback, minValue) {
  const v = String(value || "").trim();
  if (!v) return fallback;
  const num = Number(v);
  if (!Number.isFinite(num)) return fallback;
  if (minValue !== undefined && num < minValue) return fallback;
  return num;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return value;
  return Math.min(max, Math.max(min, value));
}

function askQuestion(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    const checker = process.platform === "win32" ? "where" : "which";
    const child = spawn(checker, [command], { stdio: "ignore", shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function detectAvailableInstallTargets() {
  const hasCodex = await commandExists("codex");
  const hasCopilot = await commandExists("copilot");
  if (hasCodex && hasCopilot) {
    return {
      hasCodex,
      hasCopilot,
      targets: ["codex", "copilot", "both"],
      providers: ["codex", "copilot"]
    };
  }
  if (hasCodex) {
    return { hasCodex, hasCopilot, targets: ["codex"], providers: ["codex"] };
  }
  if (hasCopilot) {
    return { hasCodex, hasCopilot, targets: ["copilot"], providers: ["copilot"] };
  }
  return {
    hasCodex,
    hasCopilot,
    targets: ["codex", "copilot", "both"],
    providers: ["codex", "copilot"]
  };
}

async function runInstallWizard(configPath, config, args) {
  const installer = config.installer || {};
  const daily = config.daily || {};
  const detected = await detectAvailableInstallTargets();
  const availableTargets = detected.targets;
  const availableProviders = detected.providers;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    console.log("ScreenShotCleanup interactive install");
    console.log("Press Enter to accept defaults.");

    const defaultTarget = normalizeTargetWithAllowed(
      args.target,
      normalizeTargetWithAllowed(installer.installTarget, availableTargets[0] || "codex", availableTargets),
      availableTargets
    );
    const targetOptionsText = availableTargets.join("|");
    const targetAnswer = await askQuestion(
      rl,
      `What CLI do you want to use (default: ${defaultTarget}, options: ${targetOptionsText})? `
    );
    const target = normalizeTargetWithAllowed(targetAnswer, defaultTarget, availableTargets);

    const defaultFolder = String(config.defaultFolder || WINDOWS_DEFAULT_FOLDER);
    const folderAnswer = await askQuestion(
      rl,
      `Screenshots folder (default: ${defaultFolder}): `
    );
    config.defaultFolder = folderAnswer.trim() ? path.resolve(folderAnswer.trim()) : defaultFolder;

    const scriptDefault = String(installer.scriptBaseName || "screenshot-cleanup-daily");
    const scriptAnswer = await askQuestion(
      rl,
      `Script base name (default: ${scriptDefault}): `
    );
    const scriptBaseName = scriptAnswer.trim() || scriptDefault;

    if (target === "codex" || target === "both") {
      const codexDefault = String(installer.codexDir || path.join(os.homedir(), ".codex"));
      const codexAnswer = await askQuestion(
        rl,
        `Codex install directory (default: ${codexDefault}): `
      );
      installer.codexDir = codexAnswer.trim() ? path.resolve(codexAnswer.trim()) : codexDefault;
    }
    if (target === "copilot" || target === "both") {
      const copilotDefault = String(installer.copilotDir || path.join(os.homedir(), ".copilot"));
      const copilotAnswer = await askQuestion(
        rl,
        `Copilot install directory (default: ${copilotDefault}): `
      );
      installer.copilotDir = copilotAnswer.trim() ? path.resolve(copilotAnswer.trim()) : copilotDefault;
    }

    const providerDefault = normalizeProviderWithAllowed(config.provider, availableProviders[0] || "codex", availableProviders);
    const providerOptionsText = availableProviders.join("|");
    const providerAnswer = await askQuestion(
      rl,
      `Classification provider (default: ${providerDefault}, options: ${providerOptionsText}): `
    );
    config.provider = normalizeProviderWithAllowed(providerAnswer, providerDefault, availableProviders);

    const modelDefault = String(config.providers?.[config.provider]?.model || "");
    const modelAnswer = await askQuestion(
      rl,
      `Default ${config.provider} model (default: ${modelDefault || "unchanged"}): `
    );
    if (modelAnswer.trim()) {
      config.providers[config.provider].model = modelAnswer.trim();
    }

    const thresholdDefault = toNumber(config.importanceThreshold, 0.65);
    const thresholdAnswer = await askQuestion(
      rl,
      `Importance threshold 0-1 (default: ${thresholdDefault}): `
    );
    const parsedThreshold = parseNumberInput(thresholdAnswer, thresholdDefault, 0);
    config.importanceThreshold = clampNumber(parsedThreshold, 0, 1);

    const dailyEnabledDefault = Boolean(daily.enabled);
    const dailyEnabledAnswer = await askQuestion(
      rl,
      `Enable daily budgeted cleanup (default: ${dailyEnabledDefault ? "yes" : "no"})? `
    );
    daily.enabled = parseBooleanInput(dailyEnabledAnswer, dailyEnabledDefault);

    if (daily.enabled) {
      const sortDefault = normalizeSort(daily.sortOrder, "oldest");
      const sortAnswer = await askQuestion(
        rl,
        `Daily sort order (default: ${sortDefault}, options: oldest|newest): `
      );
      daily.sortOrder = normalizeSort(sortAnswer, sortDefault);

      const actionDefault = normalizeAction(daily.action, "move");
      const actionAnswer = await askQuestion(
        rl,
        `Daily action (default: ${actionDefault}, options: report|move|delete): `
      );
      daily.action = normalizeAction(actionAnswer, actionDefault);

      const filesDefault = toNumber(daily.maxFilesPerRun, 20);
      const filesAnswer = await askQuestion(
        rl,
        `Max files per daily run (default: ${filesDefault}): `
      );
      daily.maxFilesPerRun = parseNumberInput(filesAnswer, filesDefault, 1);

      const callsDefault = toNumber(daily.maxModelCallsPerDay, 8);
      const callsAnswer = await askQuestion(
        rl,
        `Max model calls per day (default: ${callsDefault}): `
      );
      daily.maxModelCallsPerDay = parseNumberInput(callsAnswer, callsDefault, 0);

      const actionsDefault = toNumber(daily.maxActionsPerDay, 8);
      const actionsAnswer = await askQuestion(
        rl,
        `Max cleanup actions per day (default: ${actionsDefault}): `
      );
      daily.maxActionsPerDay = parseNumberInput(actionsAnswer, actionsDefault, 0);
    }

    installer.scriptBaseName = scriptBaseName;
    installer.installTarget = target;
    installer.defaultProviderForCodex = normalizeProvider(installer.defaultProviderForCodex, "codex");
    installer.defaultProviderForCopilot = normalizeProvider(installer.defaultProviderForCopilot, "copilot");
    config.installer = installer;
    config.daily = daily;

    console.log("");
    console.log("Install summary:");
    console.log(`  target: ${target}`);
    console.log(`  defaultFolder: ${config.defaultFolder}`);
    if (target === "codex" || target === "both") console.log(`  codexDir: ${installer.codexDir}`);
    if (target === "copilot" || target === "both") console.log(`  copilotDir: ${installer.copilotDir}`);
    console.log(`  provider: ${config.provider}`);
    console.log(`  daily.enabled: ${daily.enabled}`);
    if (daily.enabled) {
      console.log(`  daily.sortOrder: ${daily.sortOrder}`);
      console.log(`  daily.action: ${daily.action}`);
      console.log(`  daily.maxFilesPerRun: ${daily.maxFilesPerRun}`);
      console.log(`  daily.maxModelCallsPerDay: ${daily.maxModelCallsPerDay}`);
      console.log(`  daily.maxActionsPerDay: ${daily.maxActionsPerDay}`);
    }
    const confirmAnswer = await askQuestion(rl, "Apply these settings and install scripts (Y/n)? ");
    const confirmed = parseBooleanInput(confirmAnswer, true);
    if (!confirmed) {
      return { cancelled: true };
    }
    return {
      cancelled: false,
      target,
      scriptBaseName,
      installer
    };
  } finally {
    rl.close();
  }
}

async function runUninstallWizard(configPath, config, args) {
  const installer = config.installer || {};
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    console.log("ScreenShotCleanup interactive uninstall");
    console.log("Press Enter to accept defaults.");
    const defaultTarget = normalizeTarget(args.target, normalizeTarget(installer.installTarget, "both"));
    const targetAnswer = await askQuestion(
      rl,
      `Which target do you want to uninstall (default: ${defaultTarget}, options: codex|copilot|both)? `
    );
    const target = normalizeTarget(targetAnswer, defaultTarget);
    let codexDir = String(installer.codexDir || path.join(os.homedir(), ".codex"));
    let copilotDir = String(installer.copilotDir || path.join(os.homedir(), ".copilot"));
    const scriptBaseName = String(installer.scriptBaseName || "screenshot-cleanup-daily");

    if (target === "codex" || target === "both") {
      const answer = await askQuestion(
        rl,
        `Codex install directory (default: ${codexDir}): `
      );
      codexDir = answer.trim() ? path.resolve(answer.trim()) : codexDir;
    }
    if (target === "copilot" || target === "both") {
      const answer = await askQuestion(
        rl,
        `Copilot install directory (default: ${copilotDir}): `
      );
      copilotDir = answer.trim() ? path.resolve(answer.trim()) : copilotDir;
    }

    const clearManifestAnswer = await askQuestion(
      rl,
      "Remove install manifest file too (default: no)? "
    );
    const clearManifest = parseBooleanInput(clearManifestAnswer, false);

    console.log("");
    console.log("Uninstall summary:");
    console.log(`  target: ${target}`);
    if (target === "codex" || target === "both") console.log(`  codexDir: ${codexDir}`);
    if (target === "copilot" || target === "both") console.log(`  copilotDir: ${copilotDir}`);
    console.log(`  scriptBaseName: ${scriptBaseName}`);
    console.log(`  removeManifest: ${clearManifest}`);
    const confirmAnswer = await askQuestion(rl, "Proceed with uninstall (Y/n)? ");
    const confirmed = parseBooleanInput(confirmAnswer, true);
    if (!confirmed) return { cancelled: true };
    return {
      cancelled: false,
      target,
      codexDir,
      copilotDir,
      scriptBaseName,
      clearManifest
    };
  } finally {
    rl.close();
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function buildShimCommand(configPath, provider) {
  const base = ["run-daily"];
  if (provider) base.push("--provider", provider);
  if (configPath) base.push("--config", configPath);
  return base;
}

async function writeFileSafe(filePath, content, force) {
  const exists = await pathExists(filePath);
  if (exists && !force) {
    return { written: false, skipped: true, reason: "exists" };
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return { written: true, skipped: false };
}

async function installTargetShims(params) {
  const {
    targetName,
    targetDir,
    scriptBaseName,
    configPath,
    provider,
    force
  } = params;
  await ensureDir(targetDir);
  const ps1Path = path.join(targetDir, `${scriptBaseName}-${targetName}.ps1`);
  const cmdPath = path.join(targetDir, `${scriptBaseName}-${targetName}.cmd`);
  const argv = buildShimCommand(configPath, provider);
  const argvStr = argv.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(", ");
  const ps1Content = [
    "$ErrorActionPreference = 'Stop'",
    `$argsList = @(${argvStr}) + $args`,
    "screenshot-cleanup @argsList"
  ].join("\r\n");
  const cmdContent = [
    "@echo off",
    `screenshot-cleanup ${argv.map((x) => `"${x}"`).join(" ")} %*`
  ].join("\r\n");
  const ps1Result = await writeFileSafe(ps1Path, ps1Content, force);
  const cmdResult = await writeFileSafe(cmdPath, cmdContent, force);
  return {
    targetName,
    targetDir,
    files: [
      { path: ps1Path, ...ps1Result },
      { path: cmdPath, ...cmdResult }
    ]
  };
}

async function uninstallTargetShims(params) {
  const { targetName, targetDir, scriptBaseName } = params;
  const ps1Path = path.join(targetDir, `${scriptBaseName}-${targetName}.ps1`);
  const cmdPath = path.join(targetDir, `${scriptBaseName}-${targetName}.cmd`);
  const files = [ps1Path, cmdPath];
  const results = [];
  for (const filePath of files) {
    const exists = await pathExists(filePath);
    if (!exists) {
      results.push({ path: filePath, removed: false, skipped: true, reason: "missing" });
      continue;
    }
    await fs.unlink(filePath);
    results.push({ path: filePath, removed: true, skipped: false });
  }
  return { targetName, targetDir, files: results };
}

async function commandInit(configPath) {
  await ensureDir(path.dirname(configPath));
  const existing = await readJson(configPath, null);
  if (!existing) {
    await writeJson(configPath, DEFAULT_CONFIG);
    console.log(`Created config: ${configPath}`);
    return;
  }
  const merged = mergeConfig(DEFAULT_CONFIG, existing);
  await writeJson(configPath, merged);
  console.log(`Updated config defaults: ${configPath}`);
}

async function commandConfigGet(configPath) {
  const config = await loadConfig(configPath);
  console.log(JSON.stringify(config, null, 2));
}

async function commandConfigSet(configPath, key, rawValue) {
  const config = await loadConfig(configPath);
  setByPath(config, key, parsePrimitive(rawValue));
  if (key === "extensions") {
    config.extensions = normalizeExtensions(config.extensions);
  }
  await writeJson(configPath, config);
  console.log(`Updated ${key} in ${configPath}`);
}

function shortPath(filePath) {
  const home = os.homedir().toLowerCase();
  if (filePath.toLowerCase().startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function knownProviders(config) {
  return Object.keys(config?.providers || {});
}

function validateProviderConfig(config, providerName) {
  const provider = config?.providers?.[providerName];
  if (!provider) {
    const available = knownProviders(config);
    throw new Error(
      `Unknown provider "${providerName}". Available providers: ${available.length ? available.join(", ") : "none"}`
    );
  }
  if (!provider.enabled) {
    throw new Error(
      [
        `Provider "${providerName}" is disabled in config.`,
        `Enable it with: ssc config set providers.${providerName}.enabled true`,
        `Then rerun with: ssc run --provider ${providerName} ...`
      ].join("\n")
    );
  }
  if (!provider.command || !Array.isArray(provider.args)) {
    throw new Error(
      [
        `Provider "${providerName}" is missing command/args configuration.`,
        `Set command with: ssc config set providers.${providerName}.command <cli-command>`,
        `Set args with: ssc config set providers.${providerName}.args \"[\\\"...\\\"]\"`
      ].join("\n")
    );
  }
}

async function commandExists(commandName) {
  const cmd = String(commandName || "").trim();
  if (!cmd) return false;
  const hasPathSeparator = /[\\/]/.test(cmd);
  if (hasPathSeparator) {
    const abs = path.resolve(cmd);
    return pathExists(abs);
  }
  const finder = process.platform === "win32" ? "where" : "which";
  const result = await spawnCapture(finder, [cmd], { stdio: ["ignore", "pipe", "pipe"] });
  return result.code === 0;
}

async function validateProviderRuntime(config, providerName) {
  const provider = config.providers[providerName];
  const found = await commandExists(provider.command);
  if (!found) {
    throw new Error(
      [
        `Provider command not found: ${provider.command}`,
        `Install ${providerName} CLI or set full command path with:`,
        `ssc config set providers.${providerName}.command <full-path-or-command>`
      ].join("\n")
    );
  }
}

function toFriendlyProviderError(error, providerName, providerCommand) {
  const raw = String(error?.message || error || "").trim();
  if (!raw) return "provider execution failed";
  const lower = raw.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not recognized as an internal or external command")) {
    return [
      `Provider command not found: ${providerCommand}`,
      `Set it with: ssc config set providers.${providerName}.command <full-path-or-command>`
    ].join(" | ");
  }
  if (lower.includes("timeout")) {
    return "Provider timed out. Try increasing requestTimeoutMs in config.";
  }
  if (lower.includes("unknown option '--image'")) {
    return [
      "Current provider CLI does not support --image in this mode.",
      "SSC can retry with Copilot compatibility mode (prompt + local image path)."
    ].join(" | ");
  }
  return raw;
}

async function commandRun(configPath, args, options = {}) {
  const config = await loadConfig(configPath);
  config.extensions = normalizeExtensions(config.extensions);
  const dailyOpts = options.daily || null;

  const folderArg = args.folder || args._[1];
  const inputFolder = path.resolve(folderArg || config.defaultFolder);
  const provider = String(args.provider || config.provider || "codex");
  validateProviderConfig(config, provider);
  await validateProviderRuntime(config, provider);
  const model = args.model ? String(args.model) : undefined;
  const configuredMaxFiles = dailyOpts
    ? toNumber(args["max-files"], dailyOpts.maxFilesPerRun)
    : toNumber(args["max-files"], config.maxFilesPerRun);
  const maxFiles = Math.max(1, configuredMaxFiles);
  const minSizeKB = toNumber(args["min-size-kb"], config.minFileSizeKB);
  const aggressive = Boolean(args.aggressive || dailyOpts?.aggressive);
  const thresholdDefault = aggressive
    ? Math.min(toNumber(config.importanceThreshold, 0.65), 0.35)
    : config.importanceThreshold;
  const threshold = toNumber(args.threshold, thresholdDefault);
  const sortOrder =
    args["oldest-first"] || dailyOpts?.sortOrder === "oldest"
      ? "oldest"
      : args["newest-first"]
        ? "newest"
        : config.sortOrder === "oldest"
          ? "oldest"
          : "newest";
  const defaultConcurrency = provider === "copilot" ? 1 : config.maxConcurrency;
  const baseConcurrency = toNumber(args.concurrency, defaultConcurrency);
  const concurrency = baseConcurrency;
  const action = String(args.action || dailyOpts?.action || (aggressive ? "move" : config.action) || "report");
  const dryRun = Boolean(args["dry-run"] || action === "report");
  const force = Boolean(args.force);
  const verbose = Boolean(args.verbose);
  const yes = Boolean(args.yes || dailyOpts?.autoYes);
  const cachePath = getCachePath(configPath);
  const cache = config.cacheEnabled ? await readJson(cachePath, {}) : {};

  const exists = await fs
    .access(inputFolder)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`Folder not found: ${inputFolder}`);
  }

  const allFiles = await listFiles(inputFolder, {
    includeHidden: config.includeHidden,
    recursive: config.recursive,
    extensions: config.extensions
  });

  const metas = await Promise.all(allFiles.map(fileMeta));
  const sortedCandidates = metas
    .filter((meta) => meta.size >= minSizeKB * 1024)
    .sort((a, b) => (sortOrder === "oldest" ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs));

  const importantFlags = await Promise.all(sortedCandidates.map((m) => readFileImportantMeta(m.filePath)));

  let skippedMarkedImportant = 0;
  const filtered = [];
  for (let i = 0; i < sortedCandidates.length; i++) {
    if (importantFlags[i]) {
      skippedMarkedImportant += 1;
      continue;
    }
    filtered.push(sortedCandidates[i]);
    if (filtered.length >= maxFiles) break;
  }

  if (!filtered.length) {
    if (sortedCandidates.length && skippedMarkedImportant > 0) {
      console.log(
        `No pending candidates after skipping ${skippedMarkedImportant} already-marked important files.`
      );
      console.log("Use --force to reclassify already-reviewed files.");
      return;
    }
    console.log("No matching screenshot files found.");
    return;
  }

  let modelCallsUsed = 0;
  let codexFallbacksUsed = 0;
  let fatalProviderError = "";
  const prompt = makePrompt(config.promptTemplate, aggressive);
  const results = await runPool(filtered, concurrency, async (meta) => {
    if (fatalProviderError) {
      return {
        ...meta,
        important: true,
        confidence: 0,
        reason: `provider_error:${fatalProviderError}`.slice(0, 220),
        fromCache: false,
        errored: true,
        skippedByProviderFailure: true
      };
    }
    const key = cacheKey(meta);
    if (config.cacheEnabled && cache[key] && !force) {
      const cached = cache[key];
      if (cached.important) await writeFileImportantMeta(meta.filePath);
      return { ...meta, ...cached, fromCache: true };
    }
    if (dailyOpts?.remainingModelCalls !== undefined && modelCallsUsed >= dailyOpts.remainingModelCalls) {
      return {
        ...meta,
        important: true,
        confidence: 0,
        reason: "daily_model_budget_reached",
        fromCache: false,
        skippedByBudget: true
      };
    }
    try {
      modelCallsUsed += 1;
      let classified;
      try {
        classified = await runProvider(config, provider, model, meta.filePath, prompt, verbose);
      } catch (providerError) {
        const canFallback =
          provider === "copilot" &&
          config?.providers?.codex?.enabled &&
          config?.providers?.copilot?.fallbackToCodex === true &&
          shouldFallbackCopilotToCodex(providerError);
        if (!canFallback) throw providerError;
        if (verbose) {
          console.log(`provider fallback: copilot -> codex (${shortPath(meta.filePath)})`);
        }
        modelCallsUsed += 1;
        codexFallbacksUsed += 1;
        classified = await runProvider(config, "codex", undefined, meta.filePath, prompt, verbose);
      }
      const payload = { ...classified, updatedAt: new Date().toISOString() };
      if (config.cacheEnabled) cache[key] = payload;
      if (payload.important) await writeFileImportantMeta(meta.filePath);
      return { ...meta, ...payload, fromCache: false };
    } catch (error) {
      const providerCommand = String(config.providers?.[provider]?.command || provider);
      const friendly = toFriendlyProviderError(error, provider, providerCommand);
      const fatalMatch =
        friendly.toLowerCase().includes("provider command not found") ||
        friendly.toLowerCase().includes("is disabled in config") ||
        friendly.toLowerCase().includes("must define command + args");
      if (fatalMatch && !fatalProviderError) {
        fatalProviderError = friendly;
      }
      return {
        ...meta,
        important: true,
        confidence: 0,
        reason: `provider_error:${friendly}`.slice(0, 220),
        fromCache: false,
        errored: true
      };
    }
  });

  const disposable = results.filter((row) => !row.important && row.confidence >= threshold);
  const lowConfidenceNonImportant = results.filter((row) => !row.important && row.confidence < threshold);
  const strictImportant = results.filter((row) => row.important);
  const actionable = dailyOpts?.remainingActions !== undefined
    ? disposable.slice(0, Math.max(0, dailyOpts.remainingActions))
    : disposable;
  const important = results.length - disposable.length;
  const cachedCount = results.filter((row) => row.fromCache).length;
  const erroredCount = results.filter((row) => row.errored && !row.skippedByProviderFailure).length;
  const budgetSkipped = results.filter((row) => row.skippedByBudget).length;
  const providerSkipped = results.filter((row) => row.skippedByProviderFailure).length;

  console.log("");
  console.log(paint("Run Summary", ANSI.bold));
  console.log(`${labelInfo("Scanned:")} ${results.length} files`);
  if (skippedMarkedImportant) {
    console.log(`${labelInfo("Skipped (already marked important):")} ${skippedMarkedImportant}`);
  }
  console.log(`${labelInfo("Provider call attempts:")} ${modelCallsUsed}`);
  console.log(`${labelOk("Important/kept:")} ${important}`);
  console.log(`${labelWarn("Disposable candidates:")} ${disposable.length} ${labelDim(`(threshold=${threshold})`)}`);
  if (lowConfidenceNonImportant.length) {
    console.log(`${labelDim("Non-important but below threshold:")} ${lowConfidenceNonImportant.length}`);
  }
  if (dailyOpts?.remainingActions !== undefined) {
    console.log(`${labelInfo("Action budget allows:")} ${actionable.length}`);
  }
  console.log(`${labelInfo("Cache hits:")} ${cachedCount}`);
  if (budgetSkipped) console.log(`${labelWarn("Skipped by daily model budget:")} ${budgetSkipped}`);
  if (providerSkipped) console.log(`${labelWarn("Skipped by provider failure:")} ${providerSkipped}`);
  if (codexFallbacksUsed) console.log(`${labelWarn("Copilot->Codex fallbacks:")} ${codexFallbacksUsed}`);
  if (erroredCount) console.log(`${labelErr("Provider errors:")} ${erroredCount}`);
  if (verbose && erroredCount) {
    console.log("");
    console.log(paint("Provider Error Samples", ANSI.bold));
    const sampleErrors = results.filter((row) => row.errored && !row.skippedByProviderFailure).slice(0, 5);
    for (const row of sampleErrors) {
      console.log(`${labelErr("! provider_error")} ${paint(shortPath(row.filePath), ANSI.bold)}`);
      printWrappedReason(row.reason, labelErr);
    }
    if (erroredCount > sampleErrors.length) {
      console.log(`${labelErr("!")} ... and ${erroredCount - sampleErrors.length} more provider errors`);
    }
  }
  if ((erroredCount > 0 || providerSkipped > 0) && erroredCount + providerSkipped === results.length) {
    const first = results.find((row) => row.errored);
    const reason = String(first?.reason || "").replace(/^provider_error:/, "");
    console.log("");
    console.log(labelErr("All files failed provider classification."));
    if (reason) console.log(`${labelErr("First error:")} ${reason}`);
    console.log(
      `${labelWarn("Tip:")} run 'ssc config get' and verify providers.${provider}.enabled, command, args, and model.`
    );
  }

  if (actionable.length) {
    console.log("");
    console.log(paint("Disposable Candidates", ANSI.bold));
  }
  for (const row of actionable.slice(0, 20)) {
    console.log(`${labelWarn("-")} ${paint(shortPath(row.filePath), ANSI.bold)} ${labelDim("|")} ${labelInfo(`conf=${row.confidence.toFixed(2)}`)}`);
    printWrappedReason(row.reason || "no reason", labelWarn);
  }
  if (actionable.length > 20) {
    console.log(`... and ${actionable.length - 20} more`);
  }
  if (verbose && actionable.length === 0) {
    console.log("");
    console.log(paint("No disposable candidates. Keep reasons (sample):", ANSI.bold));
    for (const row of results.slice(0, 10)) {
      const decision = row.important
        ? "kept: important=true"
        : row.confidence < threshold
          ? `kept: confidence ${row.confidence.toFixed(2)} < threshold ${threshold}`
          : "kept: other";
      console.log(`${labelOk("-")} ${paint(shortPath(row.filePath), ANSI.bold)} ${labelDim("|")} ${labelOk(decision)}`);
      printWrappedReason(row.reason || "no reason", labelDim);
    }
    if (results.length > 10) {
      console.log(`... and ${results.length - 10} more kept files`);
    }
  }

  if (!actionable.length || dryRun) {
    if (config.cacheEnabled) await writeJson(cachePath, cache);
    if (dryRun) {
      console.log("");
      console.log(labelDim("Dry run mode. No files changed."));
    }
    return { modelCallsUsed, actionedCount: 0, scanned: results.length, candidates: disposable.length };
  }

  if (!yes) {
    throw new Error("Refusing to modify files without --yes. Use --action report for preview.");
  }

  if (action !== "move" && action !== "delete") {
    throw new Error(`Unsupported action: ${action}`);
  }

  if (action === "move") {
    const quarantineRoot = path.resolve(
      config.quarantineDir || path.join(inputFolder, ".quarantine")
    );
    await ensureDir(quarantineRoot);
    for (const row of actionable) {
      const relative = path.relative(inputFolder, row.filePath);
      const target = await ensureUniquePath(path.join(quarantineRoot, relative));
      await ensureDir(path.dirname(target));
      await fs.rename(row.filePath, target);
    }
    console.log("");
    console.log(labelOk(`Moved ${actionable.length} files to ${quarantineRoot}`));
  } else if (action === "delete") {
    for (const row of actionable) {
      await fs.unlink(row.filePath);
    }
    console.log("");
    console.log(labelOk(`Deleted ${actionable.length} files.`));
  }

  if (config.cacheEnabled) await writeJson(cachePath, cache);
  return {
    modelCallsUsed,
    actionedCount: actionable.length,
    scanned: results.length,
    candidates: disposable.length
  };
}

async function commandRunDaily(configPath, args) {
  const config = await loadConfig(configPath);
  const daily = config.daily || {};
  const day = dayKeyNow();
  const dailyStatePath = getDailyStatePath(configPath);
  const state = await readJson(dailyStatePath, { days: {} });
  state.days = state.days || {};
  const dayState = state.days[day] || { modelCalls: 0, actions: 0, lastRunAt: null };

  const effectiveProvider = normalizeProvider(args.provider, normalizeProvider(config.provider, "codex"));
  const effectiveModel = String(
    args.model || config?.providers?.[effectiveProvider]?.model || ""
  ).trim();
  const bypassModelLimit = effectiveProvider === "copilot" && isFreeCopilotModel(effectiveModel);
  const maxModelCallsPerDay = Math.max(0, toNumber(daily.maxModelCallsPerDay, 0));
  const maxActionsPerDay = Math.max(0, toNumber(daily.maxActionsPerDay, 0));
  const remainingModelCalls = bypassModelLimit
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, maxModelCallsPerDay - dayState.modelCalls);
  const remainingActions = Math.max(0, maxActionsPerDay - dayState.actions);

  if (!daily.enabled) {
    console.log("Daily mode disabled in config.daily.enabled.");
    return;
  }
  if (bypassModelLimit) {
    console.log(
      `Daily model-call cap bypassed for free model: ${effectiveProvider}/${effectiveModel || "unknown-model"}`
    );
  }
  if (remainingModelCalls <= 0 && remainingActions <= 0) {
    console.log(`Daily budget exhausted for ${day}.`);
    return;
  }

  const aggressive = Boolean(args.aggressive);
  const requestedDailyAction = args.action ? String(args.action) : "";
  const dailyAction = requestedDailyAction || (aggressive ? "move" : String(daily.action || "move"));
  const summary = await commandRun(configPath, args, {
    daily: {
      maxFilesPerRun: Math.max(1, toNumber(daily.maxFilesPerRun, 20)),
      sortOrder: daily.sortOrder === "newest" ? "newest" : "oldest",
      action: dailyAction,
      autoYes: dailyAction === "move" || dailyAction === "delete",
      aggressive,
      remainingModelCalls,
      remainingActions
    }
  });

  if (!bypassModelLimit) {
    dayState.modelCalls += summary?.modelCallsUsed || 0;
  }
  dayState.actions += summary?.actionedCount || 0;
  dayState.lastRunAt = new Date().toISOString();
  state.days[day] = dayState;
  await writeJson(dailyStatePath, state);
  console.log(
    `Daily usage ${day}: modelCalls=${bypassModelLimit ? "bypassed" : `${dayState.modelCalls}/${maxModelCallsPerDay}`}, actions=${dayState.actions}/${maxActionsPerDay}`
  );
}

async function commandInstall(configPath, args) {
  const config = await loadConfig(configPath);
  const installer = config.installer || {};
  const force = Boolean(args.force);
  const interactive = !args["no-prompt"] && process.stdin.isTTY;

  let target = String(args.target || installer.installTarget || "both").toLowerCase();
  let scriptBaseName = String(args["script-name"] || installer.scriptBaseName || "screenshot-cleanup-daily");
  let codexDir = path.resolve(String(args["codex-dir"] || installer.codexDir || path.join(os.homedir(), ".codex")));
  let copilotDir = path.resolve(
    String(args["copilot-dir"] || installer.copilotDir || path.join(os.homedir(), ".copilot"))
  );

  if (interactive) {
    const wizard = await runInstallWizard(configPath, config, args);
    if (wizard.cancelled) {
      console.log("Install cancelled.");
      return;
    }
    target = wizard.target;
    scriptBaseName = wizard.scriptBaseName;
    codexDir = path.resolve(String(config.installer?.codexDir || codexDir));
    copilotDir = path.resolve(String(config.installer?.copilotDir || copilotDir));
    await writeJson(configPath, config);
    console.log(`Saved config: ${configPath}`);
  } else {
    target = normalizeTarget(target, "both");
    installer.codexDir = codexDir;
    installer.copilotDir = copilotDir;
    installer.scriptBaseName = scriptBaseName;
    installer.installTarget = target;
    config.installer = installer;
    await writeJson(configPath, config);
    console.log(`Saved config: ${configPath}`);
  }

  const targets = [];
  if (target === "both" || target === "codex") {
    targets.push({
      targetName: "codex",
      targetDir: codexDir,
      provider: String(installer.defaultProviderForCodex || "codex")
    });
  }
  if (target === "both" || target === "copilot") {
    targets.push({
      targetName: "copilot",
      targetDir: copilotDir,
      provider: String(installer.defaultProviderForCopilot || "copilot")
    });
  }
  if (!targets.length) {
    throw new Error(`Invalid install target: ${target}. Use codex, copilot, or both.`);
  }

  const results = [];
  for (const t of targets) {
    const res = await installTargetShims({
      targetName: t.targetName,
      targetDir: t.targetDir,
      scriptBaseName,
      configPath,
      provider: t.provider,
      force
    });
    results.push(res);
  }

  const manifestPath = path.join(path.dirname(configPath), "install-manifest.json");
  const manifest = {
    installedAt: new Date().toISOString(),
    configPath,
    scriptBaseName,
    target,
    results
  };
  await writeJson(manifestPath, manifest);

  for (const res of results) {
    console.log(`Installed target: ${res.targetName} -> ${res.targetDir}`);
    for (const file of res.files) {
      if (file.written) {
        console.log(`  wrote: ${file.path}`);
      } else if (file.skipped) {
        console.log(`  skipped(existing): ${file.path}`);
      }
    }
  }
  console.log(`Install manifest: ${manifestPath}`);
  console.log("Use these scripts as hook commands in your CLI tool:");
  for (const res of results) {
    for (const file of res.files) {
      if (file.path.toLowerCase().endsWith(".cmd")) {
        console.log(`  ${file.path}`);
      }
    }
  }
}

async function commandUninstall(configPath, args) {
  const config = await loadConfig(configPath);
  const installer = config.installer || {};
  const interactive = !args["no-prompt"] && process.stdin.isTTY;
  let target = normalizeTarget(args.target, normalizeTarget(installer.installTarget, "both"));
  let codexDir = path.resolve(String(args["codex-dir"] || installer.codexDir || path.join(os.homedir(), ".codex")));
  let copilotDir = path.resolve(
    String(args["copilot-dir"] || installer.copilotDir || path.join(os.homedir(), ".copilot"))
  );
  let scriptBaseName = String(args["script-name"] || installer.scriptBaseName || "screenshot-cleanup-daily");
  let clearManifest = Boolean(args["clear-manifest"]);

  if (interactive) {
    const wizard = await runUninstallWizard(configPath, config, args);
    if (wizard.cancelled) {
      console.log("Uninstall cancelled.");
      return;
    }
    target = wizard.target;
    codexDir = path.resolve(wizard.codexDir);
    copilotDir = path.resolve(wizard.copilotDir);
    scriptBaseName = wizard.scriptBaseName;
    clearManifest = wizard.clearManifest;
  }

  const targets = [];
  if (target === "both" || target === "codex") {
    targets.push({ targetName: "codex", targetDir: codexDir, scriptBaseName });
  }
  if (target === "both" || target === "copilot") {
    targets.push({ targetName: "copilot", targetDir: copilotDir, scriptBaseName });
  }
  if (!targets.length) {
    throw new Error(`Invalid uninstall target: ${target}. Use codex, copilot, or both.`);
  }

  const results = [];
  for (const t of targets) {
    results.push(await uninstallTargetShims(t));
  }
  for (const res of results) {
    console.log(`Uninstalled target: ${res.targetName} -> ${res.targetDir}`);
    for (const file of res.files) {
      if (file.removed) {
        console.log(`  removed: ${file.path}`);
      } else if (file.skipped) {
        console.log(`  skipped(${file.reason}): ${file.path}`);
      }
    }
  }

  if (clearManifest) {
    const manifestPath = path.join(path.dirname(configPath), "install-manifest.json");
    if (await pathExists(manifestPath)) {
      await fs.unlink(manifestPath);
      console.log(`Removed manifest: ${manifestPath}`);
    } else {
      console.log(`Manifest not found: ${manifestPath}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args.install ? "install" : args.uninstall ? "uninstall" : args._[0] || "help").toLowerCase();
  const configPath = getConfigPath(args.config);

  if (command === "help" || args.h || args.help) {
    await printHelp(configPath);
    return;
  }
  if (command === "init") {
    await commandInit(configPath);
    return;
  }
  if (command === "config") {
    const op = String(args._[1] || "get").toLowerCase();
    if (op === "get") {
      await commandConfigGet(configPath);
      return;
    }
    if (op === "set") {
      const key = args._[2];
      const value = args._[3];
      if (!key || value === undefined) {
        throw new Error("Usage: ssc config set <key> <value>");
      }
      await commandConfigSet(configPath, key, value);
      return;
    }
    throw new Error(`Unknown config operation: ${op}`);
  }
  if (command === "run") {
    await commandRun(configPath, args);
    return;
  }
  if (command === "run-daily") {
    await commandRunDaily(configPath, args);
    return;
  }
  if (command === "schedule") {
    await commandSchedule(configPath, args);
    return;
  }
  if (command === "install") {
    await commandInstall(configPath, args);
    return;
  }
  if (command === "uninstall") {
    await commandUninstall(configPath, args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
