import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 途中までの内容を読まれないよう、一時ファイルから rename して JSON を書く。 */
export async function writeJsonAtomic(
    target: string,
    value: unknown
): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o640,
    });
    await rename(temporary, target);
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** HTML の本文・属性のどちらに入れても安全な形にする。 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * テンプレートの {{name}} を置き換える。値はエスケープ済みの HTML として扱う。
 * 未定義の名前が残るのはテンプレートとコードの食い違いなので、例外にする。
 */
export function fillTemplate(
    template: string,
    slots: Readonly<Record<string, string>>
): string {
    return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, name: string) => {
        const value = slots[name];
        if (value === undefined) {
            throw new Error(`template slot {{${name}}} has no value`);
        }
        return value;
    });
}
