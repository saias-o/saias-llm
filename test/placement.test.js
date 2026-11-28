'use strict';

// Placement: device parsing, llama-fit-params output, candidate selection and server arguments.
// No model is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const catalogs = require('../src/catalog');
const llama = require('../src/llama');
const placement = require('../src/placement');

const catalog = catalogs.bundled();
const omni = catalog.profiles.omni.variants[0];
const flash = catalog.profiles.flash.variants[0];
const files = { model: 'm.gguf', mmproj: 'mm.gguf' };
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('devices are read with their free memory', () => {
  const devices = llama.parseDevices([
    'Available devices:',
    '  Vulkan0: AMD Radeon(TM) Graphics (4037 MiB, 3835 MiB free)',
    '  Vulkan1: NVIDIA GeForce MX450 (2120 MiB, 1834 MiB free)',
  ].join('\n'));
  assert.deepEqual(devices, [
    { id: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', mib: 4037, free: 3835 },
    { id: 'Vulkan1', name: 'NVIDIA GeForce MX450', mib: 2120, free: 1834 },
  ]);
  assert.equal(placement.signature(devices), 'Vulkan0=AMD Radeon(TM) Graphics=4037|Vulkan1=NVIDIA GeForce MX450=2120');
});

test('llama-fit-params output gives the share of layers on the GPUs', () => {
  assert.deepEqual(placement.parseFit('-c 32768 -ngl -1\n'), { all: true, layers: null, total: null, share: 1 });
  const partial = placement.parseFit('-c 32768 -ngl 26\n', 'id=0, n_layer=33, n_part= 0\nid=0, n_layer=26, n_part= 0');
  assert.deepEqual(partial, { all: false, layers: 26, total: 33, share: 26 / 33 });
  assert.equal(placement.parseFit('-c 32768 -ngl 2 -ts 0,2', 'n_layer=33').share, 2 / 33);
  assert.equal(placement.parseFit('error: invalid argument'), null);
});

test('arrangements: each GPU alone, then all together; weak ones are not tried', () => {
  const gpus = [{ id: 'Vulkan1', free: 1834 }, { id: 'Vulkan0', free: 3835 }];
  assert.deepEqual(placement.deviceSets(gpus), [['Vulkan0'], ['Vulkan1'], ['Vulkan0', 'Vulkan1']]);
  assert.deepEqual(placement.deviceSets([{ id: 'CUDA0', free: 8000 }]), [['CUDA0']]);
  const kept = placement.prune([
    { devices: ['Vulkan0'], fit: { share: 1 } },
    { devices: ['Vulkan1'], fit: { share: 2 / 33 } },
    { devices: ['Vulkan0', 'Vulkan1'], fit: { share: 1 } },
    { devices: ['Vulkan2'], fit: { share: null } },
  ]);
  assert.deepEqual(kept.map(c => c.devices.join(',')), ['Vulkan0', 'Vulkan0,Vulkan1', 'Vulkan2']);
});

test('the vision encoder memory is reserved on its GPU', () => {
  const mm = placement.visionMiB(672423616);
  assert.ok(mm > 641 && mm < 1000);
  const margin = placement.MARGIN_MIB;
  assert.deepEqual(placement.fitTarget(['Vulkan0', 'Vulkan1'], 'Vulkan1', mm), [margin, margin + mm]);
  assert.deepEqual(placement.fitTarget(['Vulkan0'], 'none', mm), [margin]);
  // After a crash the text arrangement keeps its larger margin, and the encoder adds to it.
  assert.deepEqual(placement.fitTarget(['Vulkan0', 'Vulkan1'], 'Vulkan0', mm, [1536, 1536]), [1536 + mm, 1536]);
});

test('arrangements are compared on a whole turn', () => {
  const fastPrompt = { promptTps: 137, genTps: 10.4, imageSeconds: 4 };
  const fastAnswer = { promptTps: 92, genTps: 10.7, imageSeconds: 4 };
  assert.ok(placement.score(fastPrompt, false) < placement.score(fastAnswer, false));
  assert.ok(placement.score({ ...fastPrompt, imageSeconds: 60 }, true) > placement.score(fastAnswer, true));
});

test('a placement becomes llama-server arguments that let llama.cpp fit the layers', () => {
  const gpu = llama.serverArgs({ alias: 'saias-omni', port: 1, variant: omni, files,
    placement: { devices: ['Vulkan0', 'Vulkan1'], fitTarget: [512, 1454], vision: 'Vulkan1' } });
  assert.equal(value(gpu, '--device'), 'Vulkan0,Vulkan1');
  assert.equal(value(gpu, '--fit'), 'on');
  assert.equal(value(gpu, '--fit-target'), '512,1454');
  assert.equal(value(gpu, '--fit-ctx'), String(omni.server['ctx-size']));
  assert.equal(value(gpu, '--mmproj-device'), 'Vulkan1');
  assert.ok(!gpu.includes('--n-gpu-layers'));

  const cpuVision = llama.serverArgs({ alias: 'saias-omni', port: 1, variant: omni, files,
    placement: { devices: ['Vulkan0'], fitTarget: [512], vision: 'none' } });
  assert.ok(cpuVision.includes('--no-mmproj-offload'));

  const textOnly = llama.serverArgs({ alias: 'saias-omni', port: 1, variant: omni, files: { model: 'm.gguf' },
    placement: { devices: ['Vulkan0'], fitTarget: [512] } });
  assert.ok(!textOnly.includes('--mmproj') && !textOnly.includes('--mmproj-device') && !textOnly.includes('--no-mmproj-offload'));

  const cpu = llama.serverArgs({ alias: 'saias-flash', port: 1, variant: flash, files: { model: 'm.gguf' },
    placement: { devices: [], fitTarget: [] } });
  assert.equal(value(cpu, '--device'), 'none');
  assert.equal(value(cpu, '--n-gpu-layers'), '0');
});

test('without a placement, llama.cpp uses every GPU and fits on its own', () => {
  for (const profile of Object.values(catalog.profiles)) {
    for (const variant of profile.variants) {
      if (variant.device === 'auto') assert.equal(variant.server['n-gpu-layers'], undefined, `${variant.id} forces its layers`);
    }
  }
  const args = llama.serverArgs({ alias: 'saias-omni', port: 1, variant: omni, files });
  assert.ok(!args.includes('--device') && !args.includes('--n-gpu-layers'));
});

test('a smaller context is chosen only when it is clearly faster', () => {
  assert.deepEqual(placement.smallerContexts(262144, 32768), [131072, 65536, 32768]);
  assert.deepEqual(placement.smallerContexts(32768, 32768), []);
  assert.deepEqual(placement.smallerContexts(32768, undefined), []);
  // Measured on a laptop: Radeon iGPU at 262k against a GeForce MX450 at 32k.
  const radeon = { m: { promptTps: 196, genTps: 26.7 } };
  const mx450 = { ctx: 32768, m: { promptTps: 445, genTps: 50.6 } };
  assert.equal(placement.pick([radeon, mx450], false), 1);
  const slightlyFaster = { ctx: 32768, m: { promptTps: 210, genTps: 28 } };
  assert.equal(placement.pick([radeon, slightlyFaster], false), 0);
  assert.equal(placement.pick([{ ctx: 32768, m: radeon.m }], false), 0);
  assert.equal(placement.pick([], false), -1);
});

test('the measured options can be switched, and back to the automatic choice', () => {
  const stored = {
    signature: 's', date: '2026-11-28', auto: 1,
    options: [
      { devices: ['Vulkan0'], fitTarget: [512], summary: 'Radeon', layers: 'all', measured: { promptTps: 196, genTps: 26.7 } },
      { devices: ['Vulkan1'], fitTarget: [512], ctx: 32768, summary: 'MX450, 32,768-token context', layers: 'all', measured: { promptTps: 445, genTps: 50.6 } },
    ],
  };
  const auto = placement.select(stored, 'auto');
  assert.equal(auto.ctx, 32768);
  assert.equal(auto.choice, 'auto');
  const manual = placement.select(auto, 0);
  assert.equal(manual.ctx, undefined);
  assert.deepEqual(manual.devices, ['Vulkan0']);
  assert.equal(manual.choice, 0);
  assert.equal(manual.options.length, 2);
  assert.equal(placement.select(manual, 'auto').summary, 'MX450, 32,768-token context');
  assert.throws(() => placement.select(manual, 5), /No option 5/);
});

test('a placement with a smaller context passes it to llama-server', () => {
  const args = llama.serverArgs({ alias: 'saias-flash', port: 1, variant: flash, files: { model: 'm.gguf' },
    placement: { devices: ['Vulkan1'], fitTarget: [512], ctx: 32768 } });
  assert.equal(value(args, '--ctx-size'), '32768');
  assert.equal(value(args, '--fit-ctx'), '32768');
  assert.equal(args.filter(a => a === '--ctx-size').length, 1);
});

test('the catalog context floors are valid', () => {
  // Flash is the Hermes model: never below 200,000 tokens. Omni: never below 20,000.
  for (const variant of catalog.profiles.flash.variants) assert.equal(variant.contextFloor, 200000);
  for (const variant of catalog.profiles.omni.variants) assert.equal(variant.contextFloor, 20000);
  assert.deepEqual(placement.smallerContexts(262144, 200000), [200000]);
  assert.deepEqual(placement.smallerContexts(32768, 20000), [20000]);
  const broken = structuredClone(catalog);
  broken.profiles.flash.variants[0].contextFloor = 10 ** 9;
  assert.throws(() => catalogs.validate(broken), /contextFloor/);
});

test('Hermes only gets the models with at least 200,000 tokens of context', () => {
  const hermes = require('../src/integrations/hermes');
  const models = [{ id: 'saias-flash', context: 200000 }, { id: 'saias-omni', context: 32768 }, { id: 'saias-smart', context: 200000 }];
  assert.equal(hermes.MIN_CONTEXT, 200000);
  assert.deepEqual(hermes.agentModels(models).map(m => m.id), ['saias-flash', 'saias-smart']);
  assert.deepEqual(hermes.agentModels([{ id: 'saias-flash', context: 32768 }]), []);
});

test('the test image is a valid PNG', () => {
  const png = placement.testImage(16);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.subarray(-8, -4).toString('ascii'), 'IEND');
});
