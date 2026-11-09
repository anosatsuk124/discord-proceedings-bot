import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** SKILL のディレクトリ。src/ からも dist/ からも同じ深さにある。 */
export const SKILL_DIR = fileURLToPath(
    new URL('../../skills/proceedings-report/', import.meta.url)
);

export function readAsset(name: string): Promise<string> {
    return readFile(path.join(SKILL_DIR, 'assets', name), 'utf8');
}
