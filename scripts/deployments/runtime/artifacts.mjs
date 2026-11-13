import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Replaces a mutable artifact (current.json, checkpoints) without exposing a partial write. */
export async function writeFileAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** History records are append-only: an existing file may only be rewritten with identical content. */
export async function writeJsonOnce(file, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, contents, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(file, 'utf8') !== contents) {
      throw new Error(`Refusing to overwrite append-only deployment record ${file}`);
    }
  }
}
