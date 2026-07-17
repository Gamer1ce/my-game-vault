import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function readTopLevelBoxes(filename) {
  const descriptor = openSync(filename, "r");
  try {
    const fileSize = fstatSync(descriptor).size;
    const boxes = [];
    let offset = 0;
    for (let count = 0; offset + 8 <= fileSize && count < 10_000; count += 1) {
      const header = Buffer.alloc(16);
      const bytes = readSync(descriptor, header, 0, 16, offset);
      if (bytes < 8) break;
      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let size = size32;
      let headerSize = 8;
      if (size32 === 1) {
        if (bytes < 16) break;
        const largeSize = header.readBigUInt64BE(8);
        if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box 过大，无法安全处理");
        size = Number(largeSize);
        headerSize = 16;
      } else if (size32 === 0) {
        size = fileSize - offset;
      }
      if (size < headerSize || offset + size > fileSize) throw new Error(`MP4 box ${type || "未知"} 尺寸无效`);
      boxes.push({ type, offset, size });
      offset += size;
    }
    return boxes;
  } finally {
    closeSync(descriptor);
  }
}

export function fastStartStatus(filename) {
  const boxes = readTopLevelBoxes(filename);
  const moov = boxes.find((box) => box.type === "moov");
  const mdat = boxes.find((box) => box.type === "mdat");
  if (!moov || !mdat) return { supported: false, optimized: false, boxes };
  return { supported: true, optimized: moov.offset < mdat.offset, boxes };
}
