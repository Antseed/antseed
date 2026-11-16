import { app } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WHISPER_TIMEOUT_MS = 60_000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const CONFIG_FILE = 'voice-transcription.json';

// Models are no longer bundled with the installer (the tiny model alone added
// ~74 MB to every artifact). The tiny model is downloaded into userData on
// first transcription; a copy under resources/whisper/models (dev checkouts,
// old installs) is still honored if present.
const MODELS = {
  tiny: {
    id: 'tiny',
    label: 'Tiny multilingual',
    size: '~75 MB',
    fileName: 'ggml-tiny.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  },
  base: {
    id: 'base',
    label: 'Base multilingual',
    size: '~142 MB',
    fileName: 'ggml-base.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  },
} as const;

type VoiceModelId = keyof typeof MODELS;

export type VoiceTranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

type VoiceConfig = { selectedModel: VoiceModelId };

function cleanTranscript(text: string): string {
  const trimmed = text.trim();
  const normalized = trimmed.toUpperCase();
  const emptyMarkers = new Set([
    '[INAUDIBLE]',
    '(INAUDIBLE)',
    '[SILENCE]',
    '(SILENCE)',
    '[BLANK_AUDIO]',
    '(BLANK_AUDIO)',
    '[BLANK AUDIO]',
    '(BLANK AUDIO)',
  ]);
  return emptyMarkers.has(normalized) ? '' : trimmed;
}

function isVoiceModelId(value: unknown): value is VoiceModelId {
  return typeof value === 'string' && value in MODELS;
}

function getWhisperBasePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'whisper');
  return path.resolve(process.cwd(), 'resources/whisper');
}

function getUserWhisperPath(): string {
  return path.join(app.getPath('userData'), 'whisper');
}

function getConfigPath(): string {
  return path.join(getUserWhisperPath(), CONFIG_FILE);
}

function getWhisperBinaryPath(): string {
  const executable = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return path.join(getWhisperBasePath(), 'bin', `${process.platform}-${process.arch}`, executable);
}

function getBundledModelPath(modelId: VoiceModelId): string {
  return path.join(getWhisperBasePath(), 'models', MODELS[modelId].fileName);
}

function getInstalledModelPath(modelId: VoiceModelId): string {
  return path.join(getUserWhisperPath(), 'models', MODELS[modelId].fileName);
}

async function readVoiceConfig(): Promise<VoiceConfig> {
  try {
    const data = JSON.parse(await readFile(getConfigPath(), 'utf8')) as Record<string, unknown>;
    return { selectedModel: isVoiceModelId(data.selectedModel) ? data.selectedModel : 'tiny' };
  } catch {
    return { selectedModel: 'tiny' };
  }
}

async function writeVoiceConfig(config: VoiceConfig): Promise<void> {
  await mkdir(getUserWhisperPath(), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2));
}

/** Resolve a model file: a bundled copy wins, otherwise the userData install. */
function resolveModelPath(modelId: VoiceModelId): string {
  const bundledPath = getBundledModelPath(modelId);
  return existsSync(bundledPath) ? bundledPath : getInstalledModelPath(modelId);
}

function modelExists(modelId: VoiceModelId): boolean {
  return existsSync(resolveModelPath(modelId));
}

async function getSelectedModelPath(): Promise<{ modelId: VoiceModelId; modelPath: string }> {
  const { selectedModel } = await readVoiceConfig();
  if (selectedModel === 'base' && modelExists('base')) {
    return { modelId: 'base', modelPath: resolveModelPath('base') };
  }
  return { modelId: 'tiny', modelPath: resolveModelPath('tiny') };
}

async function downloadModel(modelId: VoiceModelId): Promise<void> {
  const model = MODELS[modelId];
  const targetPath = getInstalledModelPath(modelId);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download`;

  try {
    const response = await fetch(model.url, { signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(tempPath, bytes);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Model download timed out after ${MODEL_DOWNLOAD_TIMEOUT_MS / 60_000} minutes.`);
    }
    throw error;
  }
}

// Serializes concurrent first-use downloads (e.g. two quick recordings) so a
// model is only fetched once.
const pendingDownloads = new Map<VoiceModelId, Promise<void>>();

async function ensureModelDownloaded(modelId: VoiceModelId): Promise<void> {
  if (modelExists(modelId)) return;
  let pending = pendingDownloads.get(modelId);
  if (!pending) {
    pending = downloadModel(modelId).finally(() => { pendingDownloads.delete(modelId); });
    pendingDownloads.set(modelId, pending);
  }
  await pending;
}

function runWhisper(binaryPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Local transcription timed out.'));
    }, WHISPER_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `whisper-cli exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function getVoiceTranscriptionStatus() {
  const binaryPath = getWhisperBinaryPath();
  const selected = await readVoiceConfig();
  const resolved = await getSelectedModelPath();
  const models = Object.values(MODELS).map((model) => ({
    id: model.id,
    label: model.label,
    size: model.size,
    installed: modelExists(model.id),
    selected: resolved.modelId === model.id,
    bundled: existsSync(getBundledModelPath(model.id)),
  }));

  // A missing model file is not an error — it is downloaded automatically on
  // first transcription (or via install). Only a missing binary is fatal.
  const missing = !existsSync(binaryPath) ? `Missing whisper binary: ${binaryPath}` : null;

  return {
    available: !missing,
    selectedModel: selected.selectedModel,
    activeModel: resolved.modelId,
    binaryPath,
    modelPath: resolved.modelPath,
    models,
    error: missing,
  };
}

export async function setVoiceTranscriptionModel(modelId: string) {
  if (!isVoiceModelId(modelId)) return { ok: false, error: 'Unknown voice model.' };
  if (modelId === 'base' && !modelExists('base')) return { ok: false, error: 'Install Base multilingual first.' };
  await writeVoiceConfig({ selectedModel: modelId });
  return { ok: true, status: await getVoiceTranscriptionStatus() };
}

export async function installVoiceTranscriptionModel(modelId: string) {
  if (!isVoiceModelId(modelId)) return { ok: false, error: 'Unknown voice model.' };
  try {
    await ensureModelDownloaded(modelId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Installing base is an explicit upgrade, so switch to it; installing tiny
  // (pre-fetching the default) leaves the selection alone.
  if (modelId === 'base') await writeVoiceConfig({ selectedModel: 'base' });
  return { ok: true, status: await getVoiceTranscriptionStatus() };
}

export async function transcribeVoiceAudio(audio: ArrayBuffer | Uint8Array): Promise<VoiceTranscriptionResult> {
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (bytes.byteLength === 0) return { ok: false, error: 'No audio was recorded.' };
  if (bytes.byteLength > MAX_AUDIO_BYTES) return { ok: false, error: 'Recording is too large to transcribe locally.' };

  const status = await getVoiceTranscriptionStatus();
  if (!status.available) return { ok: false, error: status.error || 'Local transcription is not installed.' };

  // First use: fetch the active model into userData (models are no longer
  // bundled with the installer).
  try {
    await ensureModelDownloaded(status.activeModel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not download the voice model: ${detail}` };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'vpr-whisper-'));
  try {
    const audioPath = path.join(dir, 'input.wav');
    const outputBase = path.join(dir, 'transcript');
    await writeFile(audioPath, Buffer.from(bytes));

    await runWhisper(status.binaryPath, [
      '-m', status.modelPath,
      '-f', audioPath,
      '-l', 'auto',
      '-otxt',
      '-of', outputBase,
    ]);

    const text = cleanTranscript(await readFile(`${outputBase}.txt`, 'utf8'));
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
