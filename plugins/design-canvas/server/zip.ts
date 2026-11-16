import { deflateRawSync, inflateRawSync } from "node:zlib";

/** A file in a zip archive; `name` uses forward slashes. */
export interface ZipEntry {
  name: string;
  data: Buffer;
  /** Modification time in ms since the epoch. */
  mtime: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, in local time as zip tools expect. */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 2)));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip archive of the entries: deflated when that is smaller, stored otherwise; UTF-8 names. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data);
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const crc = crc32(entry.data);
    const { time, date } = dosTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export interface ReadZipLimits {
  /** Most files to read. */
  maxEntries: number;
  /** Most bytes the files may add up to once unpacked. */
  maxBytes: number;
}

/** Reads the files of a zip archive written by `writeZip` or a common zip tool (stored or deflated). */
export function readZip(zip: Buffer, limits: ReadZipLimits = { maxEntries: 5000, maxBytes: 200 * 1024 * 1024 }): ZipEntry[] {
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip archive");
  const count = zip.readUInt16LE(end + 10);
  if (count > limits.maxEntries) throw new Error(`The zip has more than ${limits.maxEntries} files`);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Broken zip directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const unpacked = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const body = zip.subarray(dataAt, dataAt + size);
    if (method !== 0 && method !== 8) throw new Error(`${name} uses an unsupported zip compression`);
    total += unpacked;
    if (total > limits.maxBytes) throw new Error(`The zip unpacks to more than ${limits.maxBytes / 1024 / 1024} MB`);
    // The declared size bounds the output too, so a lying header cannot unpack more.
    const data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(1, unpacked) }) : Buffer.from(body);
    if (data.length !== unpacked) throw new Error(`${name} is damaged in the zip`);
    entries.push({ name, data, mtime: 0 });
  }
  return entries;
}
