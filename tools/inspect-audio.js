/**
 * SunoGen metadata inspector (dev tool).
 *
 * Reads a Suno audio file either from a URL or a local path and reports the
 * embedded tags plus any clip UUID / Suno URL found in the bytes. Used to
 * decide whether downloads can be matched back to a clip after a rename.
 *
 *   node tools/inspect-audio.js --url="https://.../clip/<uuid>.m4a"
 *   node tools/inspect-audio.js --file=/path/to/song.mp3
 */
import fs from "node:fs";

function arg(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function decodeText(buf) {
  if (!buf.length) return "";
  const enc = buf[0];
  const body = buf.subarray(1);
  try {
    if (enc === 1) return body.toString("utf16le").replace(/\u0000.*/, "").trim();
    if (enc === 2) return body.toString("utf16be").replace(/\u0000.*/, "").trim();
    if (enc === 3) return body.toString("utf8").replace(/\u0000.*/, "").trim();
    return body.toString("latin1").replace(/\u0000.*/, "").trim();
  } catch (e) {
    return "";
  }
}

function parseId3(buf) {
  const tags = {};
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") return tags;
  const version = buf[3];
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let pos = 10;
  if (flags & 0x40) {
    const ext = version === 4 ? syncsafe(buf, pos) : buf.readUInt32BE(pos);
    pos += ext;
  }
  const end = Math.min(buf.length, 10 + size);
  while (pos + 10 <= end) {
    const id = buf.toString("latin1", pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = version === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    if (fsize <= 0 || pos + 10 + fsize > end) break;
    const frame = buf.subarray(pos + 10, pos + 10 + fsize);
    const key = id.replace(/^\x00+/, "");
    if (/^T/.test(id) && id !== "TXXX") {
      tags[key] = decodeText(frame);
    } else if (id === "COMM" || id === "USLT") {
      tags[key] = decodeText(frame.subarray(4));
    } else if (id === "TXXX") {
      const desc = decodeText(frame);
      tags["TXXX"] = (tags["TXXX"] ? tags["TXXX"] + " | " : "") + desc;
    } else if (id === "WXXX" || id === "W***") {
      tags[id] = decodeText(frame.subarray(1));
    }
    pos += 10 + fsize;
  }
  return tags;
}

function parseMp4Atoms(buf, start, end, out) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    const dataStart = pos + header;
    const dataEnd = pos + size;
    out.push({ type, start: pos, dataStart, dataEnd });
    if (["moov", "trak", "mdia", "minf", "stbl", "udta", "ilst"].includes(type)) {
      parseMp4Atoms(buf, dataStart, dataEnd, out);
    }
    if (type === "meta") {
      parseMp4Atoms(buf, dataStart + 4, dataEnd, out);
    }
    pos += size;
  }
}

function parseMp4Tags(buf) {
  const atoms = [];
  parseMp4Atoms(buf, 0, buf.length, atoms);
  const tags = {};
  const ilst = atoms.find((a) => a.type === "ilst");
  if (!ilst) return tags;
  let pos = ilst.dataStart;
  while (pos + 8 <= ilst.dataEnd) {
    const size = buf.readUInt32BE(pos);
    const name = buf.toString("latin1", pos + 4, pos + 8);
    if (size < 8 || pos + size > ilst.dataEnd) break;
    const itemStart = pos + 8;
    const itemEnd = pos + size;
    let p = itemStart;
    while (p + 8 <= itemEnd) {
      const dsize = buf.readUInt32BE(p);
      const dtype = buf.toString("latin1", p + 4, p + 8);
      if (dsize < 8 || p + dsize > itemEnd) break;
      const payload = buf.subarray(p + 8 + 8, p + dsize);
      let value = "";
      try {
        value = payload.toString("utf8").replace(/\u0000+$/g, "").trim();
      } catch (e) {}
      if (value) tags[name] = (tags[name] ? tags[name] + " | " : "") + value;
      p += dsize;
    }
    pos += size;
  }
  return tags;
}

function scanBytes(buf) {
  const text = buf.toString("latin1");
  const uuids = Array.from(new Set((text.match(new RegExp(UUID_RE.source, "gi")) || []).map((s) => s.toLowerCase())));
  const sunoHits = Array.from(new Set((text.match(/https?:\/\/[^\s"'<>]*suno[^\s"'<>]*/gi) || []).slice(0, 5)));
  return { uuids, sunoUrls: sunoHits, mentionsSuno: /suno/i.test(text) };
}

async function load() {
  const url = arg("url");
  const file = arg("file");
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed: " + res.status);
    return { source: url, buf: Buffer.from(await res.arrayBuffer()) };
  }
  if (file) {
    return { source: file, buf: fs.readFileSync(file) };
  }
  throw new Error("pass --url= or --file=");
}

const { source, buf } = await load();
const head = buf.toString("latin1", 0, 16);
let container = "unknown";
let tags = {};
if (head.startsWith("ID3")) {
  container = "mp3/id3v2";
  tags = parseId3(buf);
} else if (head.slice(4, 8) === "ftyp" || buf.toString("latin1").includes("moov")) {
  container = "mp4/m4a";
  tags = parseMp4Tags(buf);
} else if (head.startsWith("RIFF")) {
  container = "wav";
}

console.log(
  JSON.stringify(
    {
      source,
      bytes: buf.length,
      head: JSON.stringify(head),
      container,
      tags,
      scan: scanBytes(buf)
    },
    null,
    2
  )
);
