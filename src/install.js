'use strict';

// install, update, rollback, adopt, status and clean: everything that changes what is on disk.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const catalogs = require('./catalog');
const hardware = require('./hardware');
const llama = require('./llama');
const store = require('./store');
const ui = require('./ui');
const { downloadFile, extractArchives, hashFile } = require('./download');
const { resolveProfile, resolveSelection, resolveAll, recommended, filesFor } = require('./resolve');
const { modelVersion, installedVariant, modelVersions, variantsFor } = catalogs;
const { hubRunning, HUB_URL } = require('./installed');
const placement = require('./placement');
const { setTimeout: delay } = require('node:timers/promises');

// A getter: the setup can move the data folder after this module is loaded.
const previousCatalog = () => path.join(paths.home, 'catalog.previous.json');

// ---------------------------------------------------------------- helpers

function profileName(id) { return 'saias-' + id; }

function currentCatalog() {
  return catalogs.newest(catalogs.bundled(), catalogs.installed());
}

function missingBytes(state, resolution) {
  const { runtime, models } = filesFor(resolution);
  let bytes = 0;
  if (!store.runtimeDir(state, runtime.id, runtime)) bytes += runtime.archives.reduce((s, a) => s + a.size, 0);
  for (const f of models) if (!store.filePath(state, f)) bytes += f.size;
  return bytes;
}

function printHardware(hw) {
  ui.step('Hardware');
  ui.info(`${hw.platform}, ${hw.cpu}, ${hw.threads} threads, ${hw.ramGB} GB RAM`);
  if (hw.nvidia.length) for (const g of hw.nvidia) ui.info(`NVIDIA ${g.name}, ${g.vramGB} GB VRAM`);
  else ui.info('No NVIDIA GPU detected (other GPUs are used through Vulkan)');
}

function describe(r) {
  return `${r.model.name} (${r.variant.id}${r.variant.slow ? ', slow on this PC' : ''})`;
}

async function ensureRuntime(state, id, runtime) {
  const existing = store.runtimeDir(state, id, runtime);
  if (existing) { ui.ok(`${runtime.name}`); return existing; }
  const dir = path.join(paths.runtimes, id);
  const archives = [];
  for (const archive of runtime.archives) {
    const file = path.join(paths.downloads, path.basename(new URL(archive.url).pathname));
    await downloadFile({ ...archive, name: path.basename(file) }, file, path.basename(file));
    archives.push(file);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  extractArchives(archives, dir, runtime.binary);
  for (const file of archives) fs.rmSync(file, { force: true });
  store.recordRuntime(state, id, dir);
  store.save(state);
  ui.ok(runtime.name);
  return dir;
}

async function ensureFile(state, spec) {
  const existing = store.filePath(state, spec);
  if (existing && (state.files[spec.sha256]?.path === existing || await hashFile(existing) === spec.sha256)) {
    if (!state.files[spec.sha256]) store.recordFile(state, spec, existing, { verified: true });
    ui.ok(spec.name);
    return existing;
  }
  const dest = store.downloadPath(spec);
  await downloadFile(spec, dest);
  store.recordFile(state, spec, dest, { verified: true });
  store.save(state);
  ui.ok(spec.name);
  return dest;
}

// Downloads what a resolved profile needs and returns its installed state entry.
// previous: the profile's current entry, whose placement is kept while it still applies.
async function installResolution(state, r, previous, pinned = false) {
  const { runtime, models } = filesFor(r);
  const dir = await ensureRuntime(state, runtime.id, runtime);
  for (const f of models) await ensureFile(state, f);
  const entry = { variant: r.variant.id, modelVersion: r.modelVersion, ...(pinned ? { pinned: true } : {}) };
  return { ...entry, ...(await placeProfile(state, r, dir, previous)) };
}

// ---------------------------------------------------------------- placement

// Measuring needs the GPUs free: the hub is stopped during placement and started again after.
let hubPaused = false;

async function pauseHub(reason = 'Stopping SAIAS while the models are measured; it starts again afterwards.') {
  if (hubPaused || !(await hubRunning())) return;
  ui.info(reason);
  await fetch(`${HUB_URL}/saias/stop`, { method: 'POST', headers: { 'X-SAIAS': '1' } }).catch(() => {});
  for (let i = 0; i < 60 && (await hubRunning()); i++) await delay(500);
  hubPaused = true;
}

// Tools write the context of each model in their settings: they are updated after a placement
// changed it. Runs once the new state is saved.
let contextChanged = false;

async function afterPlacement() {
  if (contextChanged) {
    contextChanged = false;
    ui.info('The context of a model changed: updating the tools connected to SAIAS.');
    await require('./integrations').refresh();
  }
  if (!hubPaused) return;
  hubPaused = false;
  await require('./hub-client').ensureRunning();
}

const contextOf = entry => entry?.placement?.ctx ?? null;

// Where a profile runs (placement.js). The measured placement is kept while the variant and the
// GPUs are the same; force measures again. -> { placement } or {} when llama.cpp places it alone.
async function placeProfile(state, r, dir, previous, { force = false } = {}) {
  if (r.variant.device !== 'auto') return {};
  const name = profileName(r.profile);
  const exe = store.binaryPath(dir, r.runtime);
  const kept = previous?.placement;
  if (!force && kept && previous.variant === r.variant.id && kept.signature === placement.signature(llama.listDevices(exe))
    && (kept.floor ?? null) === (r.variant.contextFloor ?? null)) {
    ui.ok(`${name} runs on ${kept.summary}`);
    return { placement: kept };
  }
  await pauseHub();
  const files = Object.fromEntries(Object.entries(r.model.files).map(([role, f]) => [role, store.filePath(state, f)]));
  const chosen = await placement.plan({
    exe, alias: name, variant: r.variant, files, template: llama.templatePath(paths.ROOT, r.model),
    mmprojBytes: r.model.files.mmproj?.size || 0, logDir: paths.logs, ui,
  });
  if (contextOf(previous) !== (chosen?.ctx ?? null)) contextChanged = true;
  if (!chosen) { ui.ok(`${name}: llama.cpp places it on the available devices`); return {}; }
  const m = chosen.measured;
  ui.ok(`${name} runs on ${chosen.summary} (${m.genTps} tokens/s generation, ${m.promptTps} tokens/s prompt)`);
  if (chosen.options.length > 1) ui.info(`  ${chosen.options.length} options were measured; "saias placement ${r.profile}" lists them.`);
  return { placement: chosen };
}

function printPlacement(id, entry) {
  const p = entry.placement;
  if (!p) { ui.info(`${profileName(id).padEnd(12)} placed by llama.cpp on the available devices`); return; }
  ui.info(`${profileName(id)}: ${p.choice === 'auto' ? 'automatic choice' : 'your choice'} (measured ${p.date || 'earlier'})`);
  const current = p.choice === undefined || p.choice === 'auto' ? p.auto ?? 0 : p.choice;
  (p.options || [p]).forEach((o, i) => {
    const active = i === current;
    const m = o.measured;
    const image = m.imageSeconds !== undefined ? `, image ${m.imageSeconds} s` : '';
    ui.info(`  ${active ? '>' : ' '} ${i}  ${o.summary}: ${m.genTps} tokens/s generation, ${m.promptTps} tokens/s prompt${image}${i === p.auto ? '  (automatic)' : ''}`);
  });
}

// saias placement [profile] [option|auto]: lists the measured options of each profile, or
// switches one profile to another option (or back to SAIAS's automatic choice).
async function choosePlacement(name, choice) {
  const state = store.load();
  const id = name ? String(name).toLowerCase().replace(/^saias-/, '') : null;
  if (id && !state.profiles[id]) throw new Error(`${profileName(id)} is not installed.`);
  ui.step('Placement');
  if (choice === undefined) {
    for (const [pid, entry] of Object.entries(state.profiles)) if (!id || pid === id) printPlacement(pid, entry);
    if (!id || state.profiles[id]?.placement?.options?.length > 1) {
      ui.info('Switch with "saias placement <profile> <number>", or "saias placement <profile> auto".');
    }
    return;
  }
  if (!id) throw new Error('Name the profile: saias placement <profile> <number|auto>');
  const entry = state.profiles[id];
  if (!entry.placement?.options) throw new Error(`${profileName(id)} has no measured options. Run "saias tune ${id}".`);
  const before = contextOf(entry);
  entry.placement = placement.select(entry.placement, choice === 'auto' ? 'auto' : Number(choice));
  if (before !== contextOf(entry)) contextChanged = true;
  store.save(state);
  ui.ok(`${profileName(id)} runs on ${entry.placement.summary}${entry.placement.choice === 'auto' ? ' (automatic choice)' : ''}`);
  await pauseHub('Restarting SAIAS with the new placement.');
  await afterPlacement();
}

// saias tune [profile]: measures again where each installed profile runs best.
async function tune(name) {
  const catalog = catalogs.installed();
  const state = store.load();
  if (!catalog || !Object.keys(state.profiles).length) throw new Error('SAIAS is not installed. Run: saias install');
  const id = name ? String(name).toLowerCase().replace(/^saias-/, '') : null;
  if (id && !state.profiles[id]) throw new Error(`${profileName(id)} is not installed.`);
  ui.step('Placement');
  try {
    for (const [pid, entry] of Object.entries(state.profiles)) {
      if (id && pid !== id) continue;
      const variant = installedVariant(catalog, pid, entry);
      if (!variant) { ui.bad(`${profileName(pid)}: variant ${entry.variant} is missing from the catalog`); continue; }
      if (variant.device !== 'auto') { ui.info(`${profileName(pid)} uses the settings of its catalog variant`); continue; }
      const runtime = catalog.runtimes[variant.runtime];
      const dir = store.runtimeDir(state, variant.runtime, runtime);
      if (!dir) { ui.bad(`${profileName(pid)}: runtime missing, run "saias install"`); continue; }
      const r = { profile: pid, variant, model: catalog.models[variant.model], runtime };
      const { device, placement: old, ...rest } = entry;
      state.profiles[pid] = { ...rest, ...(await placeProfile(state, r, dir, entry, { force: true })) };
      store.save(state);
    }
  } finally {
    await afterPlacement();
  }
}

function snapshotPrevious(state) {
  if (!Object.keys(state.profiles).length) return;
  state.previous = { catalogVersion: state.catalogVersion, profiles: structuredClone(state.profiles) };
  if (fs.existsSync(paths.installedCatalog)) fs.copyFileSync(paths.installedCatalog, previousCatalog());
}

function sameSelection(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseProfiles(value, catalog) {
  const ids = String(value || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const unknown = ids.filter(id => !catalog.profiles[id]);
  if (unknown.length) throw new Error(`Unknown profile: ${unknown.join(', ')}. Available: ${Object.keys(catalog.profiles).join(', ')}`);
  return ids;
}

// ---------------------------------------------------------------- install

async function install(opts) {
  const catalog = currentCatalog();
  catalogs.verifyHistory(catalogs.installed(), catalog);
  const state = store.load();
  const hw = hardware.detect();
  printHardware(hw);

  ui.step(`Profiles (catalog ${catalog.version})`);
  const resolutions = resolveAll(catalog, hw, state.profiles);
  const rec = recommended(catalog, hw, state.profiles);
  for (const r of resolutions) {
    const name = profileName(r.profile).padEnd(12);
    if (r.error) { ui.info(`${name} not available: ${r.error}`); continue; }
    const missing = missingBytes(state, r);
    const status = missing ? `${ui.size(missing)} to download` : 'installed';
    ui.info(`${name} ${catalog.profiles[r.profile].summary}. ${describe(r)}: ${status}${rec.includes(r.profile) ? ' (recommended)' : ''}`);
  }

  const installed = Object.keys(state.profiles).filter(id => catalog.profiles[id]);
  const defaults = [...new Set([...rec, ...installed])];
  let chosen = opts.profiles ? parseProfiles(opts.profiles, catalog)
    : parseProfiles(await ui.ask(`Profiles to install, comma-separated (Enter = ${defaults.join(',')}):`, defaults.join(','), opts.yes || opts.check), catalog);
  for (const [id, p] of Object.entries(catalog.profiles)) if (p.always && !chosen.includes(id)) chosen.unshift(id);
  const plan = [];
  for (const id of chosen) {
    const r = resolveSelection(catalog, id, hw, state.profiles[id]);
    if (r.error) ui.bad(`Skipping ${profileName(id)}: ${r.error}`);
    else plan.push(r);
  }
  ui.info(`Selected: ${plan.map(r => profileName(r.profile)).join(', ')}`);

  const need = plan.reduce((s, r) => s + missingBytes(state, r), 0);
  if (opts.check) {
    ui.step('Check');
    ui.info(need ? `${ui.size(need)} would be downloaded.` : 'Everything selected is installed.');
    return;
  }

  ui.step('Licenses');
  for (const r of plan) {
    ui.info(`${r.model.name}: ${r.model.license.name}  ${r.model.license.url}`);
    if (r.model.license.note) ui.info(`  ${r.model.license.note}`);
  }
  if (!(await ui.confirm('Accept these model licenses?', true, opts.yes))) throw new Error('Licenses not accepted; nothing was installed.');

  if (need) {
    fs.mkdirSync(paths.home, { recursive: true });
    const free = hardware.freeBytes(paths.home);
    ui.info(`Total download: ${ui.size(need)} into ${paths.home}`);
    if (free !== null && free < need * 1.1) throw new Error(`Not enough disk space: ${ui.size(free)} free, ${ui.size(need)} needed. Free some space or set SAIAS_HOME to another drive.`);
  }

  ui.step('Runtimes and models');
  const selection = {};
  for (const r of plan) selection[r.profile] = await installResolution(state, r, state.profiles[r.profile], state.profiles[r.profile]?.pinned);

  if (!sameSelection(state.profiles, selection)) snapshotPrevious(state);
  state.profiles = selection;
  state.catalogVersion = catalog.version;
  catalogs.save(catalog);
  store.save(state);
  ui.ok(`Installed ${Object.keys(selection).map(profileName).join(', ')}`);
}

// What follows the downloads: tools, PATH, shortcut and the speed benchmark.
// opts.tools: tool ids to connect (the graphical setup); without it, every detected tool.
async function finish(opts) {
  if (!opts.noTools) {
    const tools = require('./integrations');
    // --no-hermes is kept from the first installer: it skips only Hermes.
    const ids = opts.tools || tools.ALL.filter(t => t.detect() && !(opts.noHermes && t.id === 'hermes')).map(t => t.id);
    if (ids.length) await tools.connect(ids, { yes: opts.yes });
  }
  // The native app first: the shortcut opens it when it is there.
  if (!opts.noApp) await require('./app').ensure();
  if (!opts.noPath) await require('./integrations/path').add({ yes: opts.yes });
  if (!opts.noShortcut) require('./integrations/shortcut').create();
  // Settings > Apps > Installed apps (with Uninstall) and the Start menu.
  if (!opts.noRegister) require('./integrations/windows-entry').register({ exe: require('./app').exe() });
  if (!opts.noBench && (await ui.confirm('Measure how fast each model runs on this PC now? It loads each model in turn (a few minutes).', true, opts.yes))) {
    await require('./bench').run({});
  }
  ui.step('Done');
  ui.info(require('./app').exe()
    ? 'Open SAIAS from the desktop shortcut. Start-SAIAS.cmd or "saias start --open" opens the chat in your browser.'
    : 'Start SAIAS: Start-SAIAS.cmd, the SAIAS desktop shortcut, or "saias start --open".');
  ui.info('Llama Chat: http://127.0.0.1:8090/   API for Hermes and other tools: http://127.0.0.1:8090/v1');
}

// ---------------------------------------------------------------- update and rollback

// Compares the installed catalog with the latest one. Never prints: used by "update" and by
// "update --check --json" (the native app's update banner).
async function checkUpdate() {
  const state = store.load();
  if (!Object.keys(state.profiles).length) throw new Error('SAIAS is not installed yet. Run: saias install');
  const current = catalogs.installed() || catalogs.bundled();
  let latest;
  let fetchError = null;
  try {
    latest = catalogs.newest(await catalogs.remote(), catalogs.bundled());
  } catch (e) {
    fetchError = `${e.message}. Using the catalog shipped with this copy of SAIAS.`;
    latest = catalogs.bundled();
  }
  const result = { installed: state.catalogVersion || current.version, latest: latest.version, available: false, changes: [], skipped: [], downloadBytes: 0, error: fetchError };
  if (catalogs.compareVersions(latest.version, result.installed) <= 0) return { result, state, current, latest, plan: [] };
  catalogs.verifyHistory(current, latest);
  const hw = hardware.detect();
  const plan = [];
  for (const [id, entry] of Object.entries(state.profiles)) {
    const r = resolveSelection(latest, id, hw, entry);
    if (r.error) {
      if (!installedVariant(latest, id, entry)) throw new Error(`The new catalog cannot preserve ${profileName(id)} ${modelVersion(entry)}: ${r.error}.`);
      result.skipped.push(`${profileName(id)}: ${r.error} in the new catalog; keeping ${modelVersion(entry)}.`);
      continue;
    }
    if (!entry.pinned && r.modelVersion !== modelVersion(latest.profiles[id])) {
      result.skipped.push(`${profileName(id)}: ${modelVersion(latest.profiles[id])} is incompatible with this PC; using ${r.modelVersion}.`);
    }
    plan.push(r);
    const before = installedVariant(current, id, entry);
    if (!before || modelVersion(entry) !== r.modelVersion || before.id !== r.variant.id || before.model !== r.variant.model
      || before.runtime !== r.variant.runtime || JSON.stringify(before.server) !== JSON.stringify(r.variant.server)) {
      result.changes.push({ profile: profileName(id), from: before ? current.models[before.model].name : null, to: r.model.name,
        fromVersion: before ? modelVersion(entry) : null, toVersion: r.modelVersion });
    }
  }
  result.available = true;
  result.downloadBytes = plan.reduce((s, r) => s + missingBytes(state, r), 0);
  return { result, state, current, latest, plan };
}

async function update(opts) {
  const { result, state, current, latest, plan } = await checkUpdate();
  if (opts.json) { console.log(JSON.stringify(result)); return; }
  ui.step('Catalog');
  if (result.error) ui.bad(result.error);
  ui.info(`Installed: ${result.installed}. Latest: ${result.latest}.`);
  if (!result.available) { ui.ok('SAIAS models are up to date.'); return; }
  for (const line of result.skipped) ui.bad(line);
  ui.step('Changes');
  if (!result.changes.length) ui.info('No profile changes; only catalog metadata changed.');
  for (const c of result.changes) ui.info(`${c.profile}: ${c.from ? `${c.fromVersion} ${c.from}` : 'new'} -> ${c.toVersion} ${c.to}`);
  if (result.downloadBytes) ui.info(`Download: ${ui.size(result.downloadBytes)}`);
  if (opts.check) return;
  if (!(await ui.confirm('Apply this update?', true, opts.yes))) return;

  ui.step('Licenses');
  for (const r of plan) ui.info(`${r.model.name}: ${r.model.license.name}  ${r.model.license.url}`);
  if (!(await ui.confirm('Accept these model licenses?', true, opts.yes))) return;

  ui.step('Downloads');
  const selection = { ...state.profiles };
  for (const r of plan) selection[r.profile] = await installResolution(state, r, state.profiles[r.profile], state.profiles[r.profile]?.pinned);
  snapshotPrevious(state);
  state.profiles = selection;
  state.catalogVersion = latest.version;
  catalogs.save(latest);
  store.save(state);
  ui.ok(`Updated to catalog ${latest.version}. Restart SAIAS to use the new models. "saias rollback" returns to ${current.version}.`);
}

function rollback() {
  const state = store.load();
  if (!state.previous || !fs.existsSync(previousCatalog())) throw new Error('There is no previous installation to return to.');
  const current = { catalogVersion: state.catalogVersion, profiles: state.profiles };
  const currentCatalogFile = fs.readFileSync(paths.installedCatalog);
  fs.copyFileSync(previousCatalog(), paths.installedCatalog);
  fs.writeFileSync(previousCatalog(), currentCatalogFile);
  state.profiles = state.previous.profiles;
  state.catalogVersion = state.previous.catalogVersion;
  state.previous = current;
  store.save(state);
  ui.ok(`Returned to catalog ${state.catalogVersion}. Restart SAIAS to apply it. Run "saias rollback" again to undo.`);
}

// ---------------------------------------------------------------- model versions

function requestedProfile(name) { return String(name || '').toLowerCase().replace(/^saias-/, ''); }

function requestedVersion(value) {
  if (/^latest$/i.test(value)) return null;
  if (catalogs.MODEL_VERSION.test(value)) return value;
  throw new Error('Choose a numbered version, for example 1.0, or latest.');
}

function versions(name, opts) {
  const catalog = catalogs.installed() || catalogs.bundled();
  const state = store.load();
  const id = requestedProfile(name);
  if (id && id !== 'image' && !Object.hasOwn(catalog.profiles, id)) throw new Error(`Unknown profile: ${name}`);
  const rows = [];
  if (id !== 'image') {
    const hw = hardware.detect();
    for (const key of id ? [id] : Object.keys(catalog.profiles)) {
      const profile = catalog.profiles[key];
      const entry = state.profiles[key];
      for (const version of modelVersions(profile)) {
        const r = resolveProfile(catalog, key, hw, version);
        const names = new Set(variantsFor(profile, version).map(v => catalog.models[v.model].name));
        const active = Boolean(entry && modelVersion(entry) === version);
        const installed = active ? installedVariant(catalog, key, entry) : null;
        rows.push({ profile: profileName(key), version, model: installed ? catalog.models[installed.model].name : r.model?.name || [...names].join(' / '), active,
          pinned: active && Boolean(entry.pinned), latest: version === modelVersion(profile), available: !r.error, error: r.error });
      }
    }
  }
  if (!id || id === 'image') rows.push(...require('./image').versions());
  if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const row of rows) {
    ui.info(`${row.profile} ${row.version}  ${row.model}${row.active ? row.pinned ? ' (pinned)' : ' (active)' : ''}${row.latest ? ' (latest)' : ''}${row.error ? ` — ${row.error}` : ''}`);
  }
}

async function use(name, value, opts) {
  if (!name || !value) throw new Error('Usage: saias use <profile> <1.0|latest> [--check] [--yes]');
  const id = requestedProfile(name);
  const version = requestedVersion(value);
  if (id === 'image') return require('./image').use(version, opts);
  const catalog = catalogs.installed() || catalogs.bundled();
  if (!Object.hasOwn(catalog.profiles, id)) throw new Error(`Unknown profile: ${name}`);
  const state = store.load();
  if (!Object.keys(state.profiles).length) throw new Error('Install SAIAS text profiles first with "saias install".');
  const entry = state.profiles[id];
  const hw = hardware.detect();
  const r = version === null ? resolveSelection(catalog, id, hw) : resolveProfile(catalog, id, hw, version);
  if (r.error) throw new Error(`${profileName(id)}: ${r.error}`);
  const pinned = version !== null;
  const same = modelVersion(entry) === r.modelVersion && entry?.variant === r.variant.id;
  const bytes = missingBytes(state, r);
  ui.info(`${profileName(id)} ${r.modelVersion} — ${r.model.name}${pinned ? ' (pinned)' : ' (follows compatible updates)'}`);
  if (bytes) ui.info(`Download: ${ui.size(bytes)}`);
  if (opts.check) return;
  if (same && !bytes) {
    state.profiles[id] = { ...entry, modelVersion: r.modelVersion, ...(pinned ? { pinned: true } : {}) };
    if (!pinned) delete state.profiles[id].pinned;
  } else {
    const free = hardware.freeBytes(paths.home);
    if (bytes && free !== null && free < bytes * 1.1) throw new Error(`Not enough space in ${paths.home}: ${ui.size(free)} free, ${ui.size(bytes)} needed.`);
    ui.info(`${r.model.license.name}  ${r.model.license.url}`);
    if (r.model.license.note) ui.info(r.model.license.note);
    if (!(await ui.confirm('Accept this model license?', true, opts.yes))) return;
    state.profiles[id] = await installResolution(state, r, entry, pinned);
  }
  store.save(state);
  ui.ok(`Version preference saved. Restart SAIAS to use ${profileName(id)} ${r.modelVersion}.`);
}

// ---------------------------------------------------------------- adopt

// Breadth first, so the shallowest copy of a runtime wins over backups in subfolders.
function* walk(root, maxDepth = 5) {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    yield { dir, entries };
    if (depth < maxDepth) for (const e of entries) if (e.isDirectory()) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
  }
}

// Registers runtimes and model files that already exist elsewhere on disk, so they are not
// downloaded again. Files stay where they are unless --move is given (same drive only).
async function adopt(folder, opts) {
  if (!folder || !fs.existsSync(folder)) throw new Error('Usage: saias adopt <folder> [--move] [--verify]');
  const known = [catalogs.bundled(), catalogs.installed()].filter(Boolean);
  const files = new Map();
  const runtimes = [];
  for (const c of known) {
    for (const m of Object.values(c.models)) for (const f of Object.values(m.files)) {
      if (!files.has(f.size)) files.set(f.size, new Map());
      files.get(f.size).set(f.sha256, f);
    }
    for (const [id, r] of Object.entries(c.runtimes)) runtimes.push({ id, ...r });
  }
  const state = store.load();
  const hw = hardware.detect();
  ui.step(`Adopting from ${path.resolve(folder)}`);
  let count = 0;
  for (const { dir, entries } of walk(path.resolve(folder))) {
    for (const e of entries.filter(x => x.isFile())) {
      const full = path.join(dir, e.name);
      const candidates = files.get(store.sizeOf(full));
      if (!candidates || [...candidates.values()].every(spec => state.files[spec.sha256] && store.filePath(state, spec))) continue;
      const verify = Boolean(opts.verify) || candidates.size > 1;
      const spec = verify ? candidates.get(await hashFile(full)) : candidates.values().next().value;
      if (!spec) { ui.bad(`${full}: no matching sha256, skipped`); continue; }
      if (state.files[spec.sha256] && store.filePath(state, spec)) continue;
      let target = full;
      if (opts.move) {
        target = store.downloadPath(spec);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try { fs.renameSync(full, target); } catch { target = full; ui.bad(`${spec.name}: cannot move across drives, kept in place`); }
      }
      store.recordFile(state, spec, target, { verified: verify, adopted: target === full });
      ui.ok(`${spec.name} -> ${target}`);
      count++;
    }
    const binary = entries.find(x => x.isFile() && /^llama-server(\.exe)?$/i.test(x.name));
    if (binary) {
      const v = llama.version(path.join(dir, binary.name));
      const backend = llama.backendOf(dir);
      const match = v && runtimes.find(r => r.build === v.build && r.backend === backend && r.platform === hw.platform);
      if (match && !store.runtimeDir(state, match.id, match)) {
        store.recordRuntime(state, match.id, dir, { adopted: true });
        ui.ok(`${match.name} -> ${dir}${v.commit ? ` (commit ${v.commit})` : ''}`);
        count++;
      } else if (!match) {
        ui.info(`${dir}: llama-server ${v ? `build ${v.build}` : 'of unknown version'} (${backend}) matches no catalog runtime`);
      }
    }
  }
  store.save(state);
  ui.info(count ? `Adopted ${count} item(s). Run "saias install" to finish the setup.` : 'Nothing to adopt.');
}

// ---------------------------------------------------------------- move

function bytesIn(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, n) => s + bytesIn(path.join(p, n)), 0);
}

// Moves the data folder (models, runtimes, state, logs) to another folder, for example on another
// drive, and points SAIAS at it. What lives at a fixed place stays in the standard folder: the
// private Node.js copy, data-folder.txt, and the SAIAS app's Conversations and settings.json.
// Adopted files outside the data folder stay where they are.
async function move(target) {
  if (!target) throw new Error('Usage: saias move <folder>   (for example: saias move D:\\SAIAS)');
  if (process.env.SAIAS_HOME) throw new Error('SAIAS_HOME is set: change it instead.');
  const from = paths.home;
  const to = path.resolve(target);
  const lower = p => p.toLowerCase();
  if (lower(to) === lower(from)) { ui.ok(`SAIAS already uses ${to}`); return; }
  if (lower(to).startsWith(lower(from) + path.sep) || lower(from).startsWith(lower(to) + path.sep)) {
    throw new Error('The new folder cannot contain, or be inside, the current one.');
  }
  if (await hubRunning()) throw new Error('SAIAS is running: stop it first with "saias stop".');

  const stay = lower(from) === lower(paths.standard) ? new Set(['data-folder.txt', 'image-folder.txt', 'installation.lock', 'node', 'conversations', 'settings.json']) : new Set();
  const names = fs.existsSync(from) ? fs.readdirSync(from).filter(n => !stay.has(n.toLowerCase())) : [];
  fs.mkdirSync(to, { recursive: true });
  const clash = names.filter(n => fs.existsSync(path.join(to, n)));
  if (clash.length) throw new Error(`${to} already has ${clash.join(', ')}: choose an empty folder.`);
  const need = names.reduce((s, n) => s + bytesIn(path.join(from, n)), 0);
  // Within one drive the files are renamed; to another drive they are copied, which needs room.
  const free = hardware.freeBytes(to);
  const otherDrive = lower(path.parse(from).root) !== lower(path.parse(to).root);
  if (otherDrive && free !== null && free < need + 256e6) throw new Error(`Not enough space in ${to}: ${ui.size(free)} free, ${ui.size(need)} to move.`);

  const state = store.load();
  ui.step(`Moving ${ui.size(need)} from ${from} to ${to}`);
  for (const name of names) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    ui.ok(name);
  }

  // state.json records absolute paths: rebase the ones inside the old folder.
  const rebase = p => (p && lower(p).startsWith(lower(from) + path.sep) ? path.join(to, p.slice(from.length + 1)) : p);
  for (const f of Object.values(state.files)) f.path = rebase(f.path);
  for (const r of Object.values(state.runtimes)) r.dir = rebase(r.dir);
  require('./image').rebaseFolder(rebase);
  paths.setHome(to);
  store.save(state);
  ui.ok(`SAIAS now uses ${to}. Restart SAIAS if it was open.`);
}

// ---------------------------------------------------------------- status and clean

async function status(opts) {
  const state = store.load();
  const catalog = catalogs.installed();
  const hub = await hubRunning();
  if (opts.json) {
    const models = require('./installed').installedModels();
    console.log(JSON.stringify({ home: paths.home, catalogVersion: state.catalogVersion, profiles: state.profiles, models,
      image: require('./image').status(), benchmarks: state.benchmarks || {}, hub }, null, 2));
    return;
  }
  printHardware(hardware.detect());
  ui.step('Installation');
  ui.info(`Data folder: ${paths.home}`);
  if (!catalog || !Object.keys(state.profiles).length) { ui.todo('SAIAS is not installed. Run: saias install'); return; }
  ui.info(`Catalog: ${state.catalogVersion}`);
  for (const [id, entry] of Object.entries(state.profiles)) {
    const variant = installedVariant(catalog, id, entry);
    if (!variant) { ui.bad(`${profileName(id)}: variant ${entry.variant} is missing from the catalog`); continue; }
    const model = catalog.models[variant.model];
    const runtime = catalog.runtimes[variant.runtime];
    const filesOk = Object.values(model.files).every(f => store.filePath(state, f));
    const runtimeOk = store.runtimeDir(state, variant.runtime, runtime);
    const line = `${profileName(id).padEnd(12)} ${modelVersion(entry)}${entry.pinned ? ' (pinned)' : ''} ${model.name}, ${runtime.name}${entry.placement ? `, on ${entry.placement.summary}` : entry.device ? `, device ${entry.device}` : ''}`;
    if (filesOk && runtimeOk) ui.ok(line); else ui.bad(`${line}: files missing, run "saias install"`);
    const b = state.benchmarks?.[id];
    if (b && b.variant === entry.variant && modelVersion(b) === modelVersion(entry)) {
      ui.info(`${''.padEnd(17)}${b.genTps} tokens/s generation, ${b.promptTps?.[4096] ?? b.promptTps?.[512] ?? '?'} tokens/s prompt (${b.rating}, measured ${b.date.slice(0, 10)})`);
    } else {
      ui.info(`${''.padEnd(17)}speed not measured yet: run "saias bench"`);
    }
  }
  ui.step('Hub');
  if (hub) for (const p of hub.profiles) ui.info(`${p.id.padEnd(12)} ${p.status}`);
  else ui.info('Not running. Start it with Start-SAIAS.cmd or "saias start".');
}

function referenced(state) {
  const keep = { files: new Set(), runtimes: new Set() };
  const add = (catalog, profiles) => {
    if (!catalog) return;
    for (const [id, entry] of Object.entries(profiles || {})) {
      const v = installedVariant(catalog, id, entry);
      if (!v) continue;
      keep.runtimes.add(v.runtime);
      for (const f of Object.values(catalog.models[v.model].files)) keep.files.add(f.sha256);
    }
  };
  add(catalogs.installed(), state.profiles);
  try { add(catalogs.validate(JSON.parse(fs.readFileSync(previousCatalog(), 'utf8'))), state.previous?.profiles); } catch { /* no previous */ }
  return keep;
}

// Deletes downloaded files no profile uses any more (current or previous installation).
// Adopted files outside the SAIAS folder are only forgotten, never deleted.
async function clean(opts) {
  const state = store.load();
  const keep = referenced(state);
  const doomed = [];
  for (const [sha, f] of Object.entries(state.files)) if (!keep.files.has(sha)) doomed.push({ kind: 'file', key: sha, path: f.path, adopted: f.adopted });
  for (const [id, r] of Object.entries(state.runtimes)) if (!keep.runtimes.has(id)) doomed.push({ kind: 'runtime', key: id, path: r.dir, adopted: r.adopted });
  ui.step('Clean');
  if (!doomed.length) { ui.ok('Nothing to clean.'); return; }
  for (const d of doomed) ui.info(`${d.adopted ? 'forget' : 'delete'} ${d.path}`);
  if (!(await ui.confirm('Proceed?', false, opts.yes))) return;
  for (const d of doomed) {
    if (!d.adopted && d.path.startsWith(paths.home)) fs.rmSync(d.path, { recursive: true, force: true });
    if (d.kind === 'file') delete state.files[d.key]; else delete state.runtimes[d.key];
  }
  store.save(state);
  ui.ok('Done.');
}

const locked = operation => (...args) => store.withLock(() => operation(...args));
module.exports = {
  install: opts => opts.check ? install(opts) : store.withLock(() => install(opts)).finally(afterPlacement),
  update: opts => (opts.check || opts.json) ? update(opts) : store.withLock(() => update(opts)).finally(afterPlacement),
  use: (name, value, opts) => opts.check ? use(name, value, opts) : store.withLock(() => use(name, value, opts)).finally(afterPlacement),
  rollback: locked(rollback),
  tune: name => store.withLock(() => tune(name)),
  placement: (name, choice) => store.withLock(() => choosePlacement(name, choice)),
  move: locked(move), adopt: locked(adopt), clean: locked(clean), finish, status, versions, profileName, currentCatalog, missingBytes,
};
