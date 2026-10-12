import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');

export function solverSources(projectRoot, solverRoot) {
  const sources = {};
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.venv', 'build', '__pycache__'].includes(entry.name)) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith('.py') || entry.name === 'requirements.txt') sources[relative(projectRoot, file).replaceAll('\\', '/')] = sha(readFileSync(file));
    }
  }
  collect(solverRoot);
  return sources;
}

/** Validate all onedir resources, not just the small bootloader executable. */
export function runtimeInventory(directory) {
  const root = resolve(directory), files = {};
  let bytes = 0;
  function collect(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.gitkeep') continue;
      const file = join(current, entry.name), name = relative(root, file).replaceAll('\\', '/');
      if (entry.isDirectory()) { collect(file); continue; }
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(file), resolved = resolve(dirname(file), target);
        if (isAbsolute(target) || !resolved.startsWith(`${root}${sep}`)) throw new Error(`求解资源符号链接必须留在打包目录内：${name}`);
        files[name] = { link: target };
      } else if (entry.isFile()) {
        const contents = readFileSync(file);
        files[name] = { sha256: sha(contents), bytes: contents.length, ...(process.platform === 'win32' ? {} : { executable: (lstatSync(file).mode & 0o111) !== 0 }) };
        bytes += contents.length;
      } else throw new Error(`求解目录包含不支持的文件类型：${name}`);
    }
  }
  collect(root);
  return { sha256: sha(JSON.stringify(files)), fileCount: Object.keys(files).length, bytes, files };
}
