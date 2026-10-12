import { join } from 'node:path';
import { main, requireVenv, run, solverRoot, venvPython } from './solver-tools.mjs';

main(() => {
  requireVenv();
  run(venvPython, ['-m', 'unittest', 'discover', '-s', join(solverRoot, 'tests'), '-p', 'test_*.py', '-v']);
});
