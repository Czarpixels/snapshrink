/*
 * tinyzip — a dependency-free ZIP writer (STORE method, no compression).
 *
 * Images are already compressed, so storing them uncompressed keeps the code
 * tiny while producing a perfectly valid .zip. Exposes one function:
 *
 *   makeZip([{ name: "a.jpg", data: Uint8Array }, ...]) -> Blob
 *
 * Implements ZIP local file headers + central directory + end-of-central-dir,
 * with correct CRC-32 checksums. UTF-8 filenames flagged (bit 11).
 */
(function (global) {
  "use strict";

  // Precomputed CRC-32 lookup table.
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeUint32LE(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }
  function writeUint16LE(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const entries = files.map(function (f) {
      const nameBytes = encoder.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      return { nameBytes: nameBytes, data: data, crc: crc32(data) };
    });

    const LOCAL_HEADER = 30;
    const CENTRAL_HEADER = 46;
    const EOCD = 22;

    let localSize = 0;
    let centralSize = 0;
    for (const e of entries) {
      localSize += LOCAL_HEADER + e.nameBytes.length + e.data.length;
      centralSize += CENTRAL_HEADER + e.nameBytes.length;
    }

    const total = localSize + centralSize + EOCD;
    const buffer = new ArrayBuffer(total);
    const view = new DataView(buffer);
    const out = new Uint8Array(buffer);

    let offset = 0;
    const centralRecords = [];

    // Local file headers + data.
    for (const e of entries) {
      const localOffset = offset;
      writeUint32LE(view, offset, 0x04034b50); // local file header signature
      writeUint16LE(view, offset + 4, 20);      // version needed
      writeUint16LE(view, offset + 6, 0x0800);  // flags: UTF-8 filename
      writeUint16LE(view, offset + 8, 0);       // method: 0 = store
      writeUint16LE(view, offset + 10, 0);      // mod time
      writeUint16LE(view, offset + 12, 0x21);   // mod date (1980-01-01)
      writeUint32LE(view, offset + 14, e.crc);
      writeUint32LE(view, offset + 18, e.data.length); // compressed size
      writeUint32LE(view, offset + 22, e.data.length); // uncompressed size
      writeUint16LE(view, offset + 26, e.nameBytes.length);
      writeUint16LE(view, offset + 28, 0);      // extra length
      offset += LOCAL_HEADER;
      out.set(e.nameBytes, offset);
      offset += e.nameBytes.length;
      out.set(e.data, offset);
      offset += e.data.length;
      centralRecords.push({ entry: e, localOffset: localOffset });
    }

    // Central directory.
    const centralStart = offset;
    for (const rec of centralRecords) {
      const e = rec.entry;
      writeUint32LE(view, offset, 0x02014b50); // central dir signature
      writeUint16LE(view, offset + 4, 20);      // version made by
      writeUint16LE(view, offset + 6, 20);      // version needed
      writeUint16LE(view, offset + 8, 0x0800);  // flags: UTF-8
      writeUint16LE(view, offset + 10, 0);      // method
      writeUint16LE(view, offset + 12, 0);      // mod time
      writeUint16LE(view, offset + 14, 0x21);   // mod date
      writeUint32LE(view, offset + 16, e.crc);
      writeUint32LE(view, offset + 20, e.data.length);
      writeUint32LE(view, offset + 24, e.data.length);
      writeUint16LE(view, offset + 28, e.nameBytes.length);
      writeUint16LE(view, offset + 30, 0);      // extra length
      writeUint16LE(view, offset + 32, 0);      // comment length
      writeUint16LE(view, offset + 34, 0);      // disk number
      writeUint16LE(view, offset + 36, 0);      // internal attrs
      writeUint32LE(view, offset + 38, 0);      // external attrs
      writeUint32LE(view, offset + 42, rec.localOffset);
      offset += CENTRAL_HEADER;
      out.set(e.nameBytes, offset);
      offset += e.nameBytes.length;
    }

    // End of central directory.
    writeUint32LE(view, offset, 0x06054b50);
    writeUint16LE(view, offset + 4, 0);
    writeUint16LE(view, offset + 6, 0);
    writeUint16LE(view, offset + 8, entries.length);
    writeUint16LE(view, offset + 10, entries.length);
    writeUint32LE(view, offset + 12, centralSize);
    writeUint32LE(view, offset + 16, centralStart);
    writeUint16LE(view, offset + 20, 0);

    return new Blob([out], { type: "application/zip" });
  }

  global.tinyzip = { makeZip: makeZip, crc32: crc32 };
})(typeof window !== "undefined" ? window : this);
