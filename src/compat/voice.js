import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SILK_MAGIC = Buffer.from('#!SILK_V3');
const TENCENT_SILK_PREFIX = 0x02;
const VOICE_SAMPLE_RATE = 16_000;

/** Whether a buffer is SILK, with or without Tencent's 0x02 prefix. */
export function isSilkBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SILK_MAGIC.length) return false;
  if (buffer.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)) return true;
  return (
    buffer.length > SILK_MAGIC.length
    && buffer[0] === TENCENT_SILK_PREFIX
    && buffer.subarray(1, 1 + SILK_MAGIC.length).equals(SILK_MAGIC)
  );
}

/** Add the 0x02 prefix WeChat clients expect for outbound SILK. */
export function ensureTencentSilk(buffer) {
  if (isSilkBuffer(buffer) && buffer[0] === TENCENT_SILK_PREFIX) return buffer;
  if (isSilkBuffer(buffer)) {
    return Buffer.concat([Buffer.from([TENCENT_SILK_PREFIX]), buffer]);
  }
  return buffer;
}

function isWavBuffer(buffer) {
  return (
    buffer.length > 44
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

function wavFromFfmpeg(inputPath, ffmpegBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBin,
      ['-y', '-i', inputPath, '-ac', '1', '-ar', String(VOICE_SAMPLE_RATE), '-f', 'wav', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg 转换语音超时'));
    }, 30_000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-800);
        reject(new Error(`ffmpeg 退出码 ${code}${detail ? `：${detail}` : ''}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function writeTemp(buffer, suffix) {
  const filePath = path.join(
    os.tmpdir(),
    `clawbot-voice-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`,
  );
  await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

async function encodeWavToSilk(wavBuffer) {
  let silkWasm;
  try {
    silkWasm = await import('silk-wasm');
  } catch (error) {
    throw new Error(`需要 silk-wasm 才能把 WAV 编码为微信语音：${error.message}`);
  }
  const encoded = await silkWasm.encode(wavBuffer, VOICE_SAMPLE_RATE);
  return {
    silk: ensureTencentSilk(Buffer.from(encoded.data)),
    duration: Number(encoded.duration) || 0,
  };
}

/**
 * Prepare a local audio file for a native WeChat VOICE item.
 * SILK is passed through; WAV is encoded with silk-wasm; other formats use
 * ffmpeg when available. Returns a 16 kHz SILK file plus voice metadata.
 */
export async function prepareOutboundVoice(filePath) {
  const source = await fs.promises.readFile(filePath);
  const temps = [];
  const cleanup = async () => {
    await Promise.allSettled(temps.map((file) => fs.promises.unlink(file)));
  };

  try {
    if (isSilkBuffer(source)) {
      let target = filePath;
      if (source[0] !== TENCENT_SILK_PREFIX) {
        target = await writeTemp(ensureTencentSilk(source), '.silk');
        temps.push(target);
      }
      let playtimeMs = 0;
      try {
        const silkWasm = await import('silk-wasm');
        playtimeMs = Number(silkWasm.getDuration(source)) || 0;
      } catch {
        // Estimate ~2.5 KB of SILK per second when silk-wasm is absent.
        playtimeMs = Math.round((source.length / 2500) * 1000);
      }
      return {
        filePath: target,
        playtimeMs: Math.max(1, Math.round(playtimeMs)),
        sampleRate: VOICE_SAMPLE_RATE,
        encodeType: 4,
        bitsPerSample: 16,
        cleanup,
      };
    }

    let wavBuffer;
    if (isWavBuffer(source)) {
      wavBuffer = source;
    } else {
      const ffmpeg = resolveFfmpeg();
      if (!ffmpeg) {
        throw new Error(
          '该音频格式需要 ffmpeg 转码；也可以先转换成 .wav 或 .silk 再发送',
        );
      }
      wavBuffer = await wavFromFfmpeg(filePath, ffmpeg);
    }

    const encoded = await encodeWavToSilk(wavBuffer);
    const target = await writeTemp(encoded.silk, '.silk');
    temps.push(target);
    return {
      filePath: target,
      playtimeMs: Math.max(1, Math.round(encoded.duration || 0)),
      sampleRate: VOICE_SAMPLE_RATE,
      encodeType: 4,
      bitsPerSample: 16,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
