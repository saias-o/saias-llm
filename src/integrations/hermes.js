'use strict';

// Adds the SAIAS provider and the web search MCP server to Hermes Agent's config.yaml.
// Hermes ships its own Python with PyYAML, which edits the file without losing other settings.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const paths = require('../paths');
const ui = require('../ui');
const { HUB_URL } = require('../installed');
const { which, runShim } = require('./util');

const HUB = `${HUB_URL}/v1`;
// An agent turn carries tools, skills and history: Hermes only gets models with this much context.
const MIN_CONTEXT = 200000;

const MERGE = String.raw`
import datetime, json, os, shutil, sys
import yaml

path = sys.argv[1]
spec = json.loads(sys.argv[2])
cfg = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    shutil.copy2(path, path + ".bak-saias-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
providers = cfg.get("providers") or {}
providers["saias"] = spec["provider"]
cfg["providers"] = providers
servers = cfg.get("mcp_servers") or {}
servers["saias-web"] = spec["mcp"]
cfg["mcp_servers"] = servers
if spec.get("default"):
    cfg["model"] = {"provider": "custom:saias", "default": spec["default"]}
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=True, allow_unicode=True, default_flow_style=False)
`;

// Uninstall: removes what MERGE added; the default model too when it is a SAIAS one.
const REMOVE = String.raw`
import datetime, os, shutil, sys
import yaml

path = sys.argv[1]
if not os.path.exists(path):
    print("unchanged"); sys.exit(0)
with open(path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}
changed = False
providers = cfg.get("providers") or {}
if "saias" in providers:
    del providers["saias"]; changed = True
    if providers: cfg["providers"] = providers
    else: cfg.pop("providers", None)
servers = cfg.get("mcp_servers") or {}
if "saias-web" in servers:
    del servers["saias-web"]; changed = True
    if servers: cfg["mcp_servers"] = servers
    else: cfg.pop("mcp_servers", None)
model = cfg.get("model")
if isinstance(model, dict) and model.get("provider") == "custom:saias":
    cfg.pop("model"); changed = True
if changed:
    shutil.copy2(path, path + ".bak-saias-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, sort_keys=True, allow_unicode=True, default_flow_style=False)
print("removed" if changed else "unchanged")
`;

// A Python that can edit the YAML config, as { exe, env }: Hermes' own (it ships PyYAML) first.
function hermesPython(hermes) {
  const candidates = [];
  const add = (exe, sitePackages) => exe && candidates.push({ exe, env: sitePackages ? { PYTHONPATH: sitePackages } : {} });
  const venv = process.platform === 'win32' ? ['hermes-agent', 'venv', 'Scripts', 'python.exe'] : ['hermes-agent', 'venv', 'bin', 'python'];
  add(path.join(path.dirname(path.dirname(hermes)), ...venv));
  // Hermes Desktop: hermes.cmd starts a bundled Python, and the agent's packages are in
  // agent-payload\venv (whose own python.exe points to the machine Hermes was built on).
  try {
    const script = fs.readFileSync(hermes, 'utf8');
    const bundled = script.match(/"([^"]+python\.exe)"/i);
    const payload = script.match(/"([^"]*?[\\/]agent-payload)[\\/]/i);
    if (bundled && payload) add(bundled[1], path.join(payload[1], 'venv', 'Lib', 'site-packages'));
  } catch { /* not a script */ }
  add(which('python3'));
  add(which('python'));
  const works = c => fs.existsSync(c.exe) && spawnSync(c.exe, ['-c', 'import yaml'],
    { stdio: 'ignore', windowsHide: true, timeout: 20000, env: { ...process.env, ...c.env } }).status === 0;
  return candidates.find(works) || null;
}

function runPython(python, args, options = {}) {
  return execFileSync(python.exe, args, { windowsHide: true, ...options, env: { ...process.env, ...python.env } });
}

function installHermes() {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      'irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex'], { stdio: 'inherit' });
  } else {
    execFileSync('sh', ['-c', 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'], { stdio: 'inherit' });
  }
}

// The installed models Hermes can use: those that keep at least MIN_CONTEXT tokens of context.
function agentModels(models) {
  return models.filter(m => m.context >= MIN_CONTEXT);
}

function detect() {
  return true; // Offered on every install: the installer can set Hermes up from scratch.
}

// models: installed models, most capable first (see installed.js).
async function configure({ models: installed, yes, refresh = false }) {
  ui.step('Hermes');
  const models = agentModels(installed);
  if (!models.length) { ui.todo(`Hermes needs a model with at least ${MIN_CONTEXT.toLocaleString('en-US')} tokens of context; install saias-flash.`); return; }
  // saias-smart answers fastest among the capable profiles: the everyday default for an agent.
  const defaultModel = (models.find(m => m.profile === 'smart') || models[0]).id;
  let hermes = which('hermes');
  if (!hermes && (await ui.confirm('Hermes Agent is not installed. Install it with the official Nous Research installer?', true, yes))) {
    installHermes();
    hermes = which('hermes');
  }
  if (!hermes) { ui.todo('Hermes not found; run the installer again after installing Hermes.'); return; }
  const configPath = hermesConfigPath(hermes);
  const python = hermesPython(hermes);
  if (!configPath || !python) { ui.bad('Hermes configuration not found; add the provider by hand (see README).'); return; }

  // A refresh only updates the model limits: the default model stays the user's choice.
  const setDefault = !refresh && defaultModel && (await ui.confirm(`Make ${defaultModel} the default Hermes model?`, true, yes));
  const spec = {
    provider: {
      name: 'SAIAS (local)', api: HUB, transport: 'chat_completions', discover_models: false,
      default_model: defaultModel || models[0].id,
      models: Object.fromEntries(models.map(m => [m.id, { context_length: m.context, ...(m.vision ? { supports_vision: true } : {}) }])),
    },
    mcp: { command: process.execPath, args: [paths.webMcp.replace(/\\/g, '/')], timeout: 120 },
    default: setDefault ? defaultModel : null,
  };
  const script = path.join(paths.home, 'hermes-merge.py');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(script, MERGE);
  try {
    runPython(python, [script, configPath, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ui.bad(`Hermes configuration failed: ${String(e.stderr || e.message).trim()}`);
    return;
  }
  ui.ok(`SAIAS provider (${HUB}) and web search added to ${configPath} (backup: .bak-saias-*)`);
  if (setDefault) ui.ok(`Default Hermes model: custom:saias / ${defaultModel}`);
}

function hermesConfigPath(hermes) {
  try {
    return runShim(hermes, ['config', 'path'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/).pop();
  } catch {
    return null;
  }
}

function configured() {
  const hermes = which('hermes');
  const file = hermes && hermesConfigPath(hermes);
  try { return Boolean(file) && /\bsaias(-web)?:/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

// Uninstall: takes the SAIAS provider and web tools out of the Hermes config. Hermes stays.
function remove() {
  const hermes = which('hermes');
  const file = hermes && hermesConfigPath(hermes);
  const python = hermes && hermesPython(hermes);
  if (!file || !python) return false;
  const script = path.join(require('node:os').tmpdir(), `saias-hermes-remove-${process.pid}.py`);
  fs.writeFileSync(script, REMOVE);
  try {
    return String(runPython(python, [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim().endsWith('removed');
  } finally {
    fs.rmSync(script, { force: true });
  }
}

module.exports = { id: 'hermes', name: 'Hermes Agent', detect, configure, remove, configured, agentModels, MIN_CONTEXT };
