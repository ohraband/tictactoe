import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The project root is the nearest parent folder with a package.json.
// This works both from source (server/) and from the build (dist/server/).
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('Could not find the project root (package.json).');
    dir = up;
  }
  return dir;
}

export const ROOT = findRoot();
