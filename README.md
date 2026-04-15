# SSC Screenshot Cleanup

`ssc` is a Windows-friendly CLI that classifies screenshots as important vs disposable, then cleans up low-value images with strict daily budgets to keep model/token usage low.

## Features

- Interactive setup: `ssc --install`
- Interactive uninstall: `ssc --uninstall`
- Default screenshot folder on Windows: `C:\Users\matt\Pictures\Screenshots`
- Daily budgets:
  - max model calls/day
  - max cleanup actions/day
- Oldest-first cleanup mode to drain backlog gradually
- Report-only mode by default (safe)
- Configurable provider commands for Codex/Copilot CLIs
- Cached classifications to avoid repeated requests on unchanged files

## Install

### From npm (recommended once published)

```powershell
npm install -g ssc-screenshot-cleanup
ssc --install
```

### From GitHub repo

```powershell
npm install -g github:<your-github-username>/ssc-screenshot-cleanup
ssc --install
```

### Local development

```powershell
git clone <repo-url>
cd ssc-screenshot-cleanup
npm install
npm link
ssc --install
```

## Quick Start

```powershell
ssc --install
ssc run
ssc run-daily
```

`ssc run` is report-focused unless you explicitly choose cleanup actions.

## Interactive Setup

Run:

```powershell
ssc --install
```

The wizard asks for:

- target CLI: `codex`, `copilot`, or `both`
- screenshot folder
- install directories (`~/.codex`, `~/.copilot` by default)
- provider + model
- daily budget settings
- cleanup strategy (`oldest`/`newest`, `report`/`move`/`delete`)

Then it writes config and installs hook helper scripts.

## Interactive Uninstall

Run:

```powershell
ssc --uninstall
```

The wizard asks what to remove and deletes generated helper scripts from selected targets.

## Commands

```text
ssc --install
ssc --uninstall

ssc init [--config <path>]
ssc run [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
        [--max-files <n>] [--min-size-kb <n>] [--threshold <0-1>] [--concurrency <n>]
        [--oldest-first|--newest-first] [--yes] [--force] [--verbose] [--config <path>]
ssc run-daily [folder] [--provider codex|copilot] [--model <name>] [--action report|move|delete]
              [--max-files <n>] [--oldest-first|--newest-first] [--verbose] [--config <path>]

ssc install [--target codex|copilot|both] [--codex-dir <path>] [--copilot-dir <path>]
            [--script-name <name>] [--force] [--no-prompt] [--config <path>]
ssc uninstall [--target codex|copilot|both] [--codex-dir <path>] [--copilot-dir <path>]
              [--script-name <name>] [--clear-manifest] [--no-prompt] [--config <path>]

ssc config get [--config <path>]
ssc config set <key> <value> [--config <path>]
```

## Configuration

Default config location on Windows:

`%APPDATA%\screenshot-cleanup\config.json`

Key settings:

- `defaultFolder`
- `provider`
- `providers.codex` / `providers.copilot` command templates
- `daily.*` budget controls
- `installer.*` install target defaults

Provider output must resolve to JSON with:

```json
{"important": true, "confidence": 0.82, "reason": "short reason"}
```

If provider output is nested, set `outputJsonPath`.

## Daily Budget Strategy

`ssc run-daily` persists usage in:

`%APPDATA%\screenshot-cleanup\daily-state.json`

Default behavior:

- oldest-first scanning
- capped model calls/day
- capped move/delete actions/day
- no extra calls once daily budget is exhausted

## Hook Integration

`ssc --install` creates script shims in your configured CLI folders, for example:

- `C:\Users\matt\.codex\screenshot-cleanup-daily-codex.cmd`
- `C:\Users\matt\.copilot\screenshot-cleanup-daily-copilot.cmd`

If your Codex/Copilot tooling supports pre-send or post-send hooks, point those hooks to the generated `.cmd` scripts.

## Cost/Token Controls

- Keep `daily.maxModelCallsPerDay` low (start with 5-10)
- Keep `daily.maxActionsPerDay` low (start with 5-10)
- Prefer `daily.sortOrder = oldest`
- Use cheap vision models
- Keep `maxConcurrency` low (1-2)
- Reuse cache (avoid `--force` unless needed)

## Publish This CLI

### 1) Push repo to GitHub

```powershell
git init
git add .
git commit -m "Initial release: SSC screenshot cleanup CLI"
gh repo create ssc-screenshot-cleanup --public --source . --remote origin --push
```

### 2) Publish package to npm

```powershell
npm login
npm publish --access public
```

After publish, users install with:

```powershell
npm install -g ssc-screenshot-cleanup
```

## License

MIT
