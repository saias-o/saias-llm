'use strict';

// Where a profile runs on this PC: which GPUs hold the model, and where its vision encoder goes.
//
// llama.cpp sizes the layers and the context for the memory each GPU has (--fit). SAIAS chooses
// the devices. Memory alone does not say which GPU is faster: an integrated GPU can report more
// shared memory than a dedicated one that runs twice as fast. So SAIAS asks llama-fit-params how
// each arrangement fits (a few seconds, nothing is loaded), then starts llama-server with the ones
// worth trying, measures a real turn, and keeps the fastest arrangement that works.
//
//   1. Text: each GPU alone and all GPUs together, the vision encoder left out. When the catalog
//      gives a variant a context floor ("contextFloor"), a GPU too small for the full context is
//      also tried with the largest smaller context, down to that floor, that puts more layers on
//      it. The full context is kept unless the smaller one is clearly faster (CONTEXT_TRADE).
//   2. Vision (models with an mmproj): the best text devices, with the encoder on each GPU or on
//      the CPU. Its memory is reserved on its GPU, so the layers are fitted around it.
//
// A placement is stored per profile in state.json with every option that was measured, and
// reused by the hub; llama.cpp still fits the layers to the memory free at each start.
// "saias placement" shows the options and switches between them; "saias tune" measures again.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const llama = require('./llama');
const { filler } = require('./eval/suites/context');

const MARGIN_MIB = 512;        // memory left free on each GPU for the system and other apps
const RETRY_MIB = 1024;        // more margin when an arrangement crashed: some GPUs report memory they do not have
const VISION_FACTOR = 1.4;     // vision encoder: weights plus working buffers (llama.cpp: 889 MiB for a 641 MiB file)
const MIN_SHARE = 0.5;         // an arrangement offloading less than half of the best one is not tried
const CONTEXT_TRADE = 1.3;     // a smaller context is chosen only when the turn is at least 30% faster
const TURN = { prompt: 2048, answer: 128, images: 0.5 }; // the turn arrangements are compared on
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const TRIAL_PROMPT_TOKENS = 512;
const TRIAL_ANSWER_TOKENS = 64;

// "Vulkan0=AMD Radeon(TM) Graphics=4037|Vulkan1=NVIDIA GeForce MX450=2120": a placement is
// measured again when the GPUs change.
function signature(devices) {
  return devices.map(d => `${d.id}=${d.name}=${d.mib}`).join('|');
}

function fitParamsPath(serverExe) {
  const exe = path.join(path.dirname(serverExe), 'llama-fit-params' + path.extname(serverExe));
  return fs.existsSync(exe) ? exe : null;
}

// Memory the vision encoder needs on a GPU, in MiB.
function visionMiB(mmprojBytes) {
  return Math.ceil((mmprojBytes / 1024 ** 2) * VISION_FACTOR);
}

// The fit target of each device of a text arrangement: the margin (base), plus the vision
// encoder on the GPU that holds it.
function fitTarget(devices, vision, mmprojMiB, base = devices.map(() => MARGIN_MIB)) {
  return devices.map((id, i) => base[i] + (id === vision ? mmprojMiB : 0));
}

// llama-fit-params prints the fitted arguments on stdout ("-c 32768 -ngl 26 -ts 24,2") and its
// reasoning on stderr, where "n_layer=33" gives the model's layer count when it had to reduce.
function parseFit(stdout, stderr = '') {
  const ngl = stdout.match(/-ngl (-?\d+)/);
  if (!ngl) return null;
  const counts = [...stderr.matchAll(/n_layer=\s*(\d+)/g)].map(m => Number(m[1]));
  const total = counts.length ? Math.max(...counts) : null;
  const layers = Number(ngl[1]);
  const all = layers < 0 || (total !== null && layers >= total);
  return { all, layers: all ? total : layers, total, share: all ? 1 : total ? layers / total : null };
}

// Options of the variant that change how much memory the model needs.
function fitOptions(variant, files) {
  const s = variant.server;
  const options = { model: files.model };
  for (const key of ['ctx-size', 'parallel', 'batch-size', 'ubatch-size', 'flash-attn', 'cache-type-k', 'cache-type-v']) {
    if (s[key] !== undefined) options[key] = s[key];
  }
  return options;
}

function fit(fitExe, variant, files, devices, target, ctx = variant.server['ctx-size']) {
  const args = llama.toArgs({
    ...fitOptions(variant, files),
    ...(ctx ? { 'ctx-size': ctx } : {}),
    device: devices.join(','),
    'fit-target': target.join(','),
    ...(ctx ? { 'fit-ctx': ctx } : {}),
    'log-verbosity': 4, // prints the layer counts it tries (n_layer=33)
  });
  const out = spawnSync(fitExe, args, { cwd: path.dirname(fitExe), encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return parseFit(out.stdout || '', out.stderr || '');
}

// Text arrangements: each GPU alone, then all of them together, the one with the most free
// memory first.
function deviceSets(gpus) {
  const sorted = [...gpus].sort((a, b) => b.free - a.free);
  const sets = sorted.map(g => [g.id]);
  if (sorted.length > 1) sets.push(sorted.map(g => g.id));
  return sets;
}

// Drops the arrangements that offload much less than the best one: on this machine they cannot
// win. Arrangements whose share is unknown are kept.
function prune(candidates) {
  const best = Math.max(0, ...candidates.map(c => c.fit.share ?? 0));
  return candidates.filter(c => c.fit.share === null || c.fit.share >= best * MIN_SHARE);
}

// Seconds for the reference turn: lower is better.
function score(m, vision) {
  return TURN.prompt / m.promptTps + TURN.answer / m.genTps + (vision ? TURN.images * m.imageSeconds : 0);
}

// Contexts tried below the full one: halving down to the floor, which is always included.
function smallerContexts(full, floor) {
  if (!floor || floor >= full) return [];
  const sizes = [];
  for (let c = Math.floor(full / 2); c > floor; c = Math.floor(c / 2)) sizes.push(c);
  return [...sizes, floor];
}

// The measured option to use: the fastest one with the full context, unless an option with a
// smaller context makes the reference turn at least CONTEXT_TRADE times faster.
// options: [{ ctx?, m }] -> index, or -1 when none was measured.
function pick(options, vision) {
  const best = reduced => options.reduce((b, o, i) => (Boolean(o.ctx) === reduced && o.m
    && (b < 0 || score(o.m, vision) < score(options[b].m, vision)) ? i : b), -1);
  const full = best(false);
  const small = best(true);
  if (small < 0) return full;
  if (full < 0) return small;
  return score(options[full].m, vision) >= score(options[small].m, vision) * CONTEXT_TRADE ? small : full;
}

// A 1024 x 1024 gradient, as a PNG: about 1,000 image tokens, like a phone photo or screenshot.
function testImage(size = 1024) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = (x * 255) / size;
      raw[i + 1] = (y * 255) / size;
      raw[i + 2] = ((x + y) * 127) / size;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function post(port, body) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ temperature: 0, cache_prompt: false, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return { timings: json.timings || {}, seconds: (Date.now() - started) / 1000 };
}

// Starts llama-server with a placement, measures one text turn (and one image), stops it.
// -> { promptTps, genTps, imageSeconds? } or throws with the reason it failed.
async function trial({ exe, alias, variant, files, template, placement, logFile }) {
  const port = await freePort();
  const args = llama.serverArgs({ alias, port, variant, placement, files, template });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  let proc;
  try {
    fs.writeSync(fd, `
==== ${new Date().toISOString()} ${args.join(' ')}
`);
    proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let exited = null;
  proc.on('exit', code => { exited = code ?? 1; });
  proc.on('error', () => { exited = 1; });
  const crashed = () => Object.assign(new Error(`llama-server stopped (code ${exited}); log: ${logFile}`), { crashed: true });
  try {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    for (;;) {
      if (exited !== null) throw crashed();
      if (Date.now() > deadline) throw new Error('took too long to load');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch { /* still loading */ }
      await delay(500);
    }
    const guard = async request => {
      try { return await request; } catch (e) {
        for (let i = 0; i < 12 && exited === null; i++) await delay(250); // a crash closes the connection first
        throw exited !== null ? crashed() : e;
      }
    };
    const text = await guard(post(port, {
      messages: [{ role: 'user', content: filler(TRIAL_PROMPT_TOKENS, 7).join('\n') + '\n\nSummarize this log.' }],
      max_tokens: TRIAL_ANSWER_TOKENS,
      ignore_eos: true,
    }));
    const result = { promptTps: text.timings.prompt_per_second, genTps: text.timings.predicted_per_second };
    if (!(result.promptTps > 0 && result.genTps > 0)) throw new Error('no timings in the reply');
    if (files.mmproj) {
      const image = await guard(post(port, {
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'What colors are in this image?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${testImage().toString('base64')}` } },
        ] }],
        max_tokens: 1,
      }));
      result.imageSeconds = image.seconds;
    }
    return result;
  } finally {
    if (exited === null) {
      proc.kill();
      for (let i = 0; i < 40 && exited === null; i++) await delay(250);
    }
  }
}

function describe(placement, devices) {
  const name = id => devices.find(d => d.id === id)?.name || id;
  let text = placement.devices.length ? placement.devices.map(name).join(' + ') : 'the CPU';
  if (placement.ctx) text += `, ${placement.ctx.toLocaleString('en-US')}-token context`;
  if (placement.vision === undefined) return text;
  return `${text}, vision on ${placement.vision === 'none' ? 'the CPU' : name(placement.vision)}`;
}

// The fields of a placement that come from its active option.
const ACTIVE = ['devices', 'fitTarget', 'vision', 'ctx', 'summary', 'layers', 'measured'];

// Switches a stored placement to another measured option: an index into placement.options, or
// 'auto' for the one SAIAS chose.
function select(placement, choice) {
  const index = choice === 'auto' ? placement.auto : Number(choice);
  const option = placement.options?.[index];
  if (!option) throw new Error(`No option ${choice}: choose 0 to ${(placement.options?.length || 1) - 1}, or auto.`);
  const rest = Object.fromEntries(Object.entries(placement).filter(([key]) => !ACTIVE.includes(key)));
  return { ...rest, ...option, choice: choice === 'auto' ? 'auto' : index };
}

// Chooses the placement of one profile. ui: { info, ok, bad }.
// -> { devices, fitTarget, vision?, ctx?, summary, layers, measured, options, auto, choice,
// signature }, or null when this runtime cannot plan (no GPU, or no llama-fit-params):
// llama-server then fits on its own.
async function plan({ exe, alias, variant, files, template, mmprojBytes, logDir, ui }) {
  const devices = llama.listDevices(exe).map(d => ({ ...d, free: d.free ?? d.mib }));
  const fitExe = fitParamsPath(exe);
  if (!devices.length || !fitExe) return null;
  const vision = Boolean(files.mmproj);
  const mmMiB = vision ? visionMiB(mmprojBytes) : 0;
  const full = variant.server['ctx-size'];
  const logFile = path.join(logDir, `${alias}-tune.log`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, '');
  // Measures one arrangement; a crash is tried once more with a larger margin.
  // Text arrangements are measured without the vision encoder, which is placed afterwards.
  // -> { m, placement } (the placement that worked) or null.
  const run = async (placement, label, withVision = vision) => {
    ui.info(`  trying ${label}...`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const m = await trial({ exe, alias, variant, files: withVision ? files : { model: files.model }, template, placement, logFile });
        ui.info(`    ${m.promptTps.toFixed(0)} tokens/s prompt, ${m.genTps.toFixed(1)} tokens/s generation${m.imageSeconds !== undefined ? `, image in ${m.imageSeconds.toFixed(1)} s` : ''}`);
        return { m, placement };
      } catch (e) {
        ui.info(`    failed: ${e.message}`);
        if (!e.crashed || attempt || !placement.devices.length) return null;
        placement = { ...placement, fitTarget: placement.fitTarget.map(t => t + RETRY_MIB) };
        ui.info(`    again with ${RETRY_MIB} MiB more left free on each GPU...`);
      }
    }
    return null;
  };
  const config = c => ({
    devices: c.devices, fitTarget: c.fitTarget,
    ...(c.ctx ? { ctx: c.ctx } : {}), ...(c.vision !== undefined ? { vision: c.vision } : {}),
  });

  // 1. Text, with the full context and, on a GPU too small for it, a smaller one.
  const fullContext = [];
  const smallerContext = [];
  for (const set of deviceSets(devices)) {
    const target = fitTarget(set, null, 0);
    const f = fit(fitExe, variant, files, set, target);
    if (f) fullContext.push({ devices: set, fitTarget: target, fit: f });
    if (!f || f.all || !full) continue;
    let found = null;
    for (const ctx of smallerContexts(full, variant.contextFloor)) {
      const g = fit(fitExe, variant, files, set, target, ctx);
      if (g?.share != null && (!found || g.share > found.fit.share)) found = { ctx, fit: g };
      if (g?.all) break;
    }
    if (found && found.fit.share > (f.share ?? 0)) smallerContext.push({ devices: set, fitTarget: target, ctx: found.ctx, fit: found.fit });
  }
  // Each context size is pruned on its own, so a full context is always measured too.
  const textCandidates = [...prune(fullContext), ...prune(smallerContext)];
  if (!textCandidates.length) return null;
  const measured = [];
  if (textCandidates.length > 1) {
    ui.info(`${alias}: comparing ${textCandidates.length} arrangements (one load each)`);
    for (const c of textCandidates) {
      const tried = await run(config(c), describe(c, devices), false);
      if (tried) measured.push({ ...c, fitTarget: tried.placement.fitTarget, m: tried.m });
    }
  }
  const best = measured[pick(measured, false)] || textCandidates[0];

  // 2. Vision: on a GPU (layers refitted around it) or on the CPU.
  let options = [];
  if (vision) {
    const finalists = [];
    for (const gpu of [...devices].sort((a, b) => b.free - a.free)) {
      const target = fitTarget(best.devices, gpu.id, mmMiB, best.fitTarget);
      if (!best.devices.includes(gpu.id) && gpu.free < MARGIN_MIB + mmMiB) continue;
      const f = fit(fitExe, variant, files, best.devices, target, best.ctx || full);
      if (f) finalists.push({ devices: best.devices, ctx: best.ctx, vision: gpu.id, fitTarget: target, fit: f });
    }
    finalists.push({ devices: best.devices, ctx: best.ctx, vision: 'none', fitTarget: best.fitTarget, fit: best.fit });
    // On a single GPU that keeps every layer with the encoder there too, moving the encoder
    // cannot help: that arrangement is tried alone. With several GPUs the encoder shifts the
    // split of the layers, so every option is measured.
    const dominant = best.devices.length === 1 && finalists.find(f => f.vision === best.devices[0] && f.fit.all && best.fit.all);
    const order = dominant ? [dominant, ...finalists.filter(f => f !== dominant)] : finalists;
    ui.info(`${alias}: placing the vision encoder`);
    for (const f of order) {
      const tried = await run(config(f), describe(f, devices));
      if (tried) options.push({ ...f, fitTarget: tried.placement.fitTarget, m: tried.m });
      if (tried && f === dominant) break;
    }
  } else if (measured.length) {
    options = measured;
  } else {
    const tried = await run(config(best), describe(best, devices));
    if (tried) options = [{ ...best, fitTarget: tried.placement.fitTarget, m: tried.m }];
  }
  const auto = pick(options, vision);
  if (auto < 0) throw new Error(`${alias} could not run on any GPU arrangement; see ${logFile}`);

  const round = v => Math.round(v * 10) / 10;
  const stored = options.map(o => ({
    ...config(o),
    summary: describe(o, devices),
    layers: o.fit.all ? 'all' : o.fit.layers,
    measured: {
      promptTps: round(o.m.promptTps),
      genTps: round(o.m.genTps),
      ...(o.m.imageSeconds !== undefined ? { imageSeconds: round(o.m.imageSeconds) } : {}),
    },
  }));
  return select({ signature: signature(devices), floor: variant.contextFloor ?? null, date: new Date().toISOString().slice(0, 10), options: stored, auto }, 'auto');
}

module.exports = {
  plan, select, describe, signature, parseFit, prune, deviceSets, fitTarget, visionMiB, score, pick, smallerContexts,
  testImage, MARGIN_MIB, CONTEXT_TRADE,
};
