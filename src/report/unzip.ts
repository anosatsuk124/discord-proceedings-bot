import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * zip から 1 つのファイルを取り出す。Actions の artifact を読むためだけのもので、
 * 分割 zip や zip64 には対応しない。見つからなければ null を返す。
 */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
    const end = findEndOfCentralDirectory(zip);
    const count = zip.readUInt16LE(end + 10);
    let entry = zip.readUInt32LE(end + 16);
    for (let i = 0; i < count; i += 1) {
        if (zip.readUInt32LE(entry) !== CENTRAL_DIRECTORY_ENTRY) {
            throw new Error('corrupt zip: bad central directory entry');
        }
        const method = zip.readUInt16LE(entry + 10);
        const compressedSize = zip.readUInt32LE(entry + 20);
        const nameLength = zip.readUInt16LE(entry + 28);
        const extraLength = zip.readUInt16LE(entry + 30);
        const commentLength = zip.readUInt16LE(entry + 32);
        const localOffset = zip.readUInt32LE(entry + 42);
        const entryName = zip.toString(
            'utf8',
            entry + 46,
            entry + 46 + nameLength
        );
        if (entryName === name) {
            return extract(zip, localOffset, compressedSize, method);
        }
        entry += 46 + nameLength + extraLength + commentLength;
    }
    return null;
}

function findEndOfCentralDirectory(zip: Buffer): number {
    // 末尾のコメントは最大 65535 バイト。
    const lowest = Math.max(0, zip.length - 22 - 65535);
    for (let offset = zip.length - 22; offset >= lowest; offset -= 1) {
        if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
            return offset;
        }
    }
    throw new Error('corrupt zip: end of central directory not found');
}

function extract(
    zip: Buffer,
    localOffset: number,
    compressedSize: number,
    method: number
): Buffer {
    if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
        throw new Error('corrupt zip: bad local file header');
    }
    const nameLength = zip.readUInt16LE(localOffset + 26);
    const extraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLength + extraLength;
    const body = zip.subarray(start, start + compressedSize);
    if (method === METHOD_STORED) return Buffer.from(body);
    if (method === METHOD_DEFLATE) return inflateRawSync(body);
    throw new Error(`unsupported zip compression method: ${method}`);
}
