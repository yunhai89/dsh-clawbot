import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ensureTencentSilk,
  isSilkBuffer,
  prepareOutboundVoice,
} from '../src/compat/voice.js';

test('SILK detection and Tencent prefixing are idempotent', () => {
  const raw = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.from([1, 2, 3])]);
  assert.equal(isSilkBuffer(raw), true);
  assert.equal(isSilkBuffer(Buffer.from('RIFF......WAVE')), false);

  const prefixed = ensureTencentSilk(raw);
  assert.equal(prefixed[0], 0x02);
  assert.equal(prefixed.subarray(1, 10).toString('ascii'), '#!SILK_V3');
  assert.equal(ensureTencentSilk(prefixed), prefixed);
});

test('prepareOutboundVoice encodes WAV to 16 kHz SILK', async () => {
  const dir = `/tmp/opencode/clawbot-voice-wav-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sampleRate = 16_000;
  const ms = 200;
  const samples = Math.round((sampleRate * ms) / 1000);
  const pcmBytes = samples * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcmBytes, 40);
  const filePath = path.join(dir, 'sample.wav');
  fs.writeFileSync(filePath, wav);

  const prepared = await prepareOutboundVoice(filePath);
  try {
    assert.equal(isSilkBuffer(fs.readFileSync(prepared.filePath)), true);
    assert.equal(prepared.encodeType, 4);
    assert.equal(prepared.sampleRate, 16000);
    assert.ok(prepared.playtimeMs >= ms - 20);
  } finally {
    await prepared.cleanup();
  }
});

test('prepareOutboundVoice passes SILK through with voice metadata', async () => {
  const dir = `/tmp/opencode/clawbot-voice-${process.pid}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'sample.silk');
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.alloc(128, 1)]));

  const prepared = await prepareOutboundVoice(filePath);
  try {
    assert.equal(isSilkBuffer(fs.readFileSync(prepared.filePath)), true);
    assert.equal(fs.readFileSync(prepared.filePath)[0], 0x02);
    assert.equal(prepared.encodeType, 4);
    assert.equal(prepared.sampleRate, 16000);
    assert.equal(prepared.bitsPerSample, 16);
    assert.ok(prepared.playtimeMs >= 1);
  } finally {
    await prepared.cleanup();
  }
});
