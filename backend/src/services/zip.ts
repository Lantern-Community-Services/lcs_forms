import zlib from "node:zlib";

/**
 * A small zip writer and reader for files we make ourselves (the HMIS CSV
 * export, services/hmisExport.ts). The backend has no zip package of its own
 * (exceljs brings some in, but only for itself), and a zip of a few CSVs is a
 * few headers around deflated bytes, so it's written out here rather than
 * adding a dependency.
 *
 * Writes the classic zip format: no zip64 (each file and the whole archive
 * must stay under 4 GB), names in UTF-8, every file deflated, dated now.
 */

export interface ZipFile {
  name: string;
  data: Buffer | string;
}

/** DOS date and time, which zip headers use, for a moment in local time. */
function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Flag bit 11: the file name is UTF-8. */
const UTF8 = 0x0800;
const DEFLATE = 8;

export function makeZip(files: ZipFile[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : f.data;
    const packed = zlib.deflateRawSync(raw, { level: 6 });
    const crc = zlib.crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by: 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8, 8);
    entry.writeUInt16LE(DEFLATE, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // extra, comment, disk number, internal and external attributes: none
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/**
 * Read back a zip makeZip wrote (or any plain one: stored or deflated, no
 * zip64, no encryption), checking each file's CRC. For the export's own check
 * (scripts/hmis-export-check.ts); nothing reads uploaded zips with it.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip: no end of central directory.");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad central directory entry.");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const packed = buf.subarray(dataAt, dataAt + size);
    const raw = method === DEFLATE ? zlib.inflateRawSync(packed) : method === 0 ? Buffer.from(packed) : null;
    if (!raw) throw new Error(`${name}: compression method ${method} isn't supported.`);
    if ((zlib.crc32(raw) >>> 0) !== crc) throw new Error(`${name}: CRC doesn't match.`);
    out.set(name, raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
