import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const windowsLockErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Windows may briefly retain an executable/directory handle after a successful
// self-test (including antivirus scanning). Never retry unrelated file errors.
export async function retryWindowsFileLock(operation, options = {}) {
  const { platform = process.platform, attempts = 11, delayMs = 500, wait = sleep } = options;
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (platform !== 'win32' || !windowsLockErrors.has(error?.code) || attempt >= attempts) throw error;
      await wait(delayMs);
    }
  }
}

export async function replaceRuntimeDirectory(staging, destination, backup, options = {}) {
  const move = options.rename ?? rename;
  const exists = options.exists ?? existsSync;
  const retryMove = (from, to) => retryWindowsFileLock(() => move(from, to), options);
  let movedPrevious = false;
  if (exists(destination)) {
    await retryMove(destination, backup);
    movedPrevious = true;
  }
  try { await retryMove(staging, destination); }
  catch (error) {
    if (movedPrevious) {
      try { await retryMove(backup, destination); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError],
          `替换求解器目录失败，旧目录恢复也失败；备份保留在 ${backup}。`, { cause: error });
      }
    }
    throw error;
  }
}

// A failed rollback must leave the old runtime recoverable, even if another
// process recreated destination. Cleanup must not conceal the original error.
export async function cleanupRuntimeStaging(stagingRoot, backup, options = {}) {
  const { failure, exists = existsSync, remove = rm } = options;
  if (failure && exists(backup)) return { preserved: true };
  try {
    await retryWindowsFileLock(() => remove(stagingRoot, { recursive: true, force: true }), options);
    return { preserved: false };
  } catch (error) {
    if (failure) return { preserved: true, cleanupError: error };
    throw error;
  }
}
