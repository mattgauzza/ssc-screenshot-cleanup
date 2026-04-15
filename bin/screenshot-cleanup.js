#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const readline = require("readline");

const APP_NAME = "screenshot-cleanup";
const WINDOWS_DEFAULT_FOLDER = path.join(os.homedir(), "Pictures", "Screenshots");
const DEFAULT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

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
  maxConcurrency: 2,
  requestTimeoutMs: 30000,
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

function printHelp() {
  console.log(`Usage:
  ssc --install
  ssc --uninstall
  ssc init [--config <path>]
  ssc run [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
          [--max-files <n>] [--min-size-kb <n>] [--threshold <0-1>] [--concurrency <n>]
          [--oldest-first|--newest-first]
          [--force] [--yes] [--verbose] [--config <path>]
  ssc run-daily [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
                [--max-files <n>] [--oldest-first|--newest-first] [--verbose] [--config <path>]
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
  - Results are cached by file path + mtime + size to minimize repeated model requests.`);
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

function fillTemplate(tokens, values) {
  return tokens.map((token) => token.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? "")));
}

function withTimeout(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
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
  const promptMode = provider.promptMode === "stdin" ? "stdin" : "arg";

  if (verbose) {
    console.log(`provider cmd: ${provider.command} ${finalArgs.join(" ")}`);
  }

  const useShell = /\.(cmd|bat|ps1)$/i.test(String(provider.command || ""));
  const runOnce = (args) => {
    const child = spawn(provider.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell
    });

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

    return Promise.race([waitForExit, withTimeout(child, config.requestTimeoutMs)]);
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

  let stdout = "";
  try {
    const res = await runOnce(finalArgs);
    stdout = res.stdout;
  } catch (error) {
    const commandLower = String(provider.command || "").toLowerCase();
    const canRetryForTrustCheck =
      (providerName === "codex" || commandLower.includes("codex")) &&
      String(error?.message || "").toLowerCase().includes("not inside a trusted directory");
    if (!canRetryForTrustCheck) throw error;
    const retryArgs = withCodexSkipRepoCheck(finalArgs);
    if (verbose) {
      console.log("provider retry: adding --skip-git-repo-check");
      console.log(`provider cmd: ${provider.command} ${retryArgs.join(" ")}`);
    }
    const res = await runOnce(retryArgs);
    stdout = res.stdout;
  }
  const parsed = extractFirstJson(stdout);
  if (!parsed) {
    throw new Error(`Could not parse JSON from provider output: ${stdout.slice(0, 400)}`);
  }

  const data = getByPath(parsed, provider.outputJsonPath || "") || parsed;
  const important = Boolean(data.important);
  const confidence = Number(data.confidence ?? 0);
  const reason = String(data.reason ?? "").slice(0, 160);
  return { important, confidence, reason, raw: data };
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

async function commandRun(configPath, args, options = {}) {
  const config = await loadConfig(configPath);
  config.extensions = normalizeExtensions(config.extensions);
  const dailyOpts = options.daily || null;

  const folderArg = args.folder || args._[1];
  const inputFolder = path.resolve(folderArg || config.defaultFolder);
  const provider = String(args.provider || config.provider || "codex");
  const model = args.model ? String(args.model) : undefined;
  const configuredMaxFiles = dailyOpts
    ? toNumber(args["max-files"], dailyOpts.maxFilesPerRun)
    : toNumber(args["max-files"], config.maxFilesPerRun);
  const maxFiles = Math.max(1, configuredMaxFiles);
  const minSizeKB = toNumber(args["min-size-kb"], config.minFileSizeKB);
  const threshold = toNumber(args.threshold, config.importanceThreshold);
  const sortOrder =
    args["oldest-first"] || dailyOpts?.sortOrder === "oldest"
      ? "oldest"
      : args["newest-first"]
        ? "newest"
        : config.sortOrder === "oldest"
          ? "oldest"
          : "newest";
  const baseConcurrency = toNumber(args.concurrency, config.maxConcurrency);
  const concurrency = dailyOpts ? 1 : baseConcurrency;
  const action = String(args.action || dailyOpts?.action || config.action || "report");
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
  const filtered = metas
    .filter((meta) => meta.size >= minSizeKB * 1024)
    .sort((a, b) => (sortOrder === "oldest" ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs))
    .slice(0, maxFiles);

  if (!filtered.length) {
    console.log("No matching screenshot files found.");
    return;
  }

  let modelCallsUsed = 0;
  const prompt = config.promptTemplate;
  const results = await runPool(filtered, concurrency, async (meta) => {
    const key = cacheKey(meta);
    if (config.cacheEnabled && cache[key] && !force) {
      return { ...meta, ...cache[key], fromCache: true };
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
      const classified = await runProvider(config, provider, model, meta.filePath, prompt, verbose);
      const payload = { ...classified, updatedAt: new Date().toISOString() };
      if (config.cacheEnabled) cache[key] = payload;
      return { ...meta, ...payload, fromCache: false };
    } catch (error) {
      return {
        ...meta,
        important: true,
        confidence: 0,
        reason: `provider_error:${error.message}`.slice(0, 160),
        fromCache: false,
        errored: true
      };
    }
  });

  const disposable = results.filter((row) => !row.important && row.confidence >= threshold);
  const actionable = dailyOpts?.remainingActions !== undefined
    ? disposable.slice(0, Math.max(0, dailyOpts.remainingActions))
    : disposable;
  const important = results.length - disposable.length;
  const cachedCount = results.filter((row) => row.fromCache).length;
  const erroredCount = results.filter((row) => row.errored).length;
  const budgetSkipped = results.filter((row) => row.skippedByBudget).length;

  console.log(`Scanned: ${results.length} files`);
  console.log(`Important/kept: ${important}`);
  console.log(`Disposable candidates: ${disposable.length} (threshold=${threshold})`);
  if (dailyOpts?.remainingActions !== undefined) {
    console.log(`Action budget allows: ${actionable.length}`);
  }
  console.log(`Cache hits: ${cachedCount}`);
  if (budgetSkipped) console.log(`Skipped by daily model budget: ${budgetSkipped}`);
  if (erroredCount) console.log(`Provider errors: ${erroredCount}`);

  for (const row of actionable.slice(0, 20)) {
    console.log(
      `- ${shortPath(row.filePath)} | conf=${row.confidence.toFixed(2)} | ${row.reason || "no reason"}`
    );
  }
  if (actionable.length > 20) {
    console.log(`... and ${actionable.length - 20} more`);
  }

  if (!actionable.length || dryRun) {
    if (config.cacheEnabled) await writeJson(cachePath, cache);
    if (dryRun) console.log("Dry run mode. No files changed.");
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
    console.log(`Moved ${actionable.length} files to ${quarantineRoot}`);
  } else if (action === "delete") {
    for (const row of actionable) {
      await fs.unlink(row.filePath);
    }
    console.log(`Deleted ${actionable.length} files.`);
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

  const maxModelCallsPerDay = Math.max(0, toNumber(daily.maxModelCallsPerDay, 0));
  const maxActionsPerDay = Math.max(0, toNumber(daily.maxActionsPerDay, 0));
  const remainingModelCalls = Math.max(0, maxModelCallsPerDay - dayState.modelCalls);
  const remainingActions = Math.max(0, maxActionsPerDay - dayState.actions);

  if (!daily.enabled) {
    console.log("Daily mode disabled in config.daily.enabled.");
    return;
  }
  if (remainingModelCalls <= 0 && remainingActions <= 0) {
    console.log(`Daily budget exhausted for ${day}.`);
    return;
  }

  const summary = await commandRun(configPath, args, {
    daily: {
      maxFilesPerRun: Math.max(1, toNumber(daily.maxFilesPerRun, 20)),
      sortOrder: daily.sortOrder === "newest" ? "newest" : "oldest",
      action: String(daily.action || "move"),
      autoYes: daily.action === "move" || daily.action === "delete",
      remainingModelCalls,
      remainingActions
    }
  });

  dayState.modelCalls += summary?.modelCallsUsed || 0;
  dayState.actions += summary?.actionedCount || 0;
  dayState.lastRunAt = new Date().toISOString();
  state.days[day] = dayState;
  await writeJson(dailyStatePath, state);
  console.log(
    `Daily usage ${day}: modelCalls=${dayState.modelCalls}/${maxModelCallsPerDay}, actions=${dayState.actions}/${maxActionsPerDay}`
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
    printHelp();
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
