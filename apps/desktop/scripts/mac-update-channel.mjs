import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, parse } from 'yaml';

function isArm64(file) {
  return /arm64/i.test(file.url);
}

function extensionRank(file) {
  if (/\.zip$/i.test(file.url)) return 0;
  if (/\.dmg$/i.test(file.url)) return 1;
  return 2;
}

/** `dmg: false` for a channel that carries only the update zips (the bridge build). */
export function normalizeMacUpdateChannel(channel, { dmg = true } = {}) {
  if (!channel || !Array.isArray(channel.files)) {
    throw new Error('[release-mac] the mac update channel does not contain a files array.');
  }

  const files = [...channel.files];
  const requiredArtifacts = [
    ['x64 zip', (file) => !isArm64(file) && /\.zip$/i.test(file.url)],
    ['arm64 zip', (file) => isArm64(file) && /\.zip$/i.test(file.url)],
    ...(dmg ? [
      ['x64 dmg', (file) => !isArm64(file) && /\.dmg$/i.test(file.url)],
      ['arm64 dmg', (file) => isArm64(file) && /\.dmg$/i.test(file.url)],
    ] : []),
  ];
  const missing = requiredArtifacts.filter(([, matches]) => !files.some(matches)).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`[release-mac] the mac update channel is missing: ${missing.join(', ')}`);
  }

  files.sort((left, right) => {
    const extensionDifference = extensionRank(left) - extensionRank(right);
    if (extensionDifference !== 0) return extensionDifference;
    return Number(isArm64(left)) - Number(isArm64(right));
  });

  const x64Zip = files.find((file) => !isArm64(file) && /\.zip$/i.test(file.url));
  return {
    ...channel,
    files,
    path: x64Zip.url,
    sha512: x64Zip.sha512,
  };
}

export function normalizeMacUpdateChannelFile(channelPath, options) {
  const normalized = normalizeMacUpdateChannel(parse(readFileSync(channelPath, 'utf8')), options);
  const document = new Document(normalized);
  // Keep releaseDate a quoted string: emitted plain, an ISO timestamp is
  // resolved to a Date object by js-yaml's default schema on the updater side.
  const releaseDate = document.get('releaseDate', true);
  if (releaseDate) releaseDate.type = 'QUOTE_SINGLE';
  writeFileSync(channelPath, document.toString({ lineWidth: 0 }));
  return normalized;
}

export function prepareMacReleaseArtifacts(releaseDir, channelPath, options) {
  const channel = normalizeMacUpdateChannelFile(channelPath, options);
  const localNames = readdirSync(releaseDir);
  const artifacts = [channelPath];

  for (const file of channel.files) {
    const extension = path.extname(file.url).toLowerCase();
    const arm64 = isArm64(file);
    const candidates = localNames.filter((name) => (
      !name.endsWith('.blockmap')
      && path.extname(name).toLowerCase() === extension
      && /arm64/i.test(name) === arm64
    ));
    if (candidates.length !== 1) {
      throw new Error(`[release-mac] Expected one local artifact for ${file.url}, found: ${candidates.join(', ') || 'none'}`);
    }

    const sourcePath = path.join(releaseDir, candidates[0]);
    const targetPath = path.join(releaseDir, file.url);
    if (sourcePath !== targetPath) renameSync(sourcePath, targetPath);
    artifacts.push(targetPath);

    const sourceBlockmapPath = `${sourcePath}.blockmap`;
    const targetBlockmapPath = `${targetPath}.blockmap`;
    if (!existsSync(sourceBlockmapPath)) {
      throw new Error(`[release-mac] Missing blockmap for ${candidates[0]}`);
    }
    if (sourceBlockmapPath !== targetBlockmapPath) renameSync(sourceBlockmapPath, targetBlockmapPath);
    artifacts.push(targetBlockmapPath);
  }

  return { channel, artifacts };
}
