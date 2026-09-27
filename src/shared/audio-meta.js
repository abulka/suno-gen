/**
 * SunoGen audio-metadata helper.
 *
 * Downloaded Suno files embed the clip id: M4A/MP3 carry a comment like
 * "made with suno; created=...; id=<uuid>", and WAV carries a C2PA provenance
 * block containing "com.suno.provenance" + "icontentIdx$<uuid>". We read only
 * the head and tail slices of a file (the metadata lives at one end or the
 * other), so a folder scan stays cheap.
 *
 * Loaded by the side panel before panel.js.
 */
(function (root) {
  "use strict";

  const AUDIO_EXT = /\.(mp3|wav|m4a|mp4|flac|ogg|aac|opus)$/i;
  const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const UUID_RE = new RegExp(UUID_SRC, "gi");

  function decode(bytes) {
    try {
      return new TextDecoder("latin1").decode(bytes);
    } catch (err) {
      let out = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return out;
    }
  }

  function allUuids(text) {
    const found = text.match(UUID_RE) || [];
    return Array.from(new Set(found.map((u) => u.toLowerCase())));
  }

  /** Normalise a filename to a title-like stem for clipTitles matching. */
  function stemOf(name) {
    return String(name || "")
      .replace(/^.*[\\/]/, "")
      .replace(/\.(mp3|wav|m4a|mp4|flac|ogg|aac|opus)$/i, "")
      .replace(/\s*\(\d+\)$/, "")
      .trim()
      .toLowerCase();
  }

  /**
   * Match a filename stem against a title -> id map. Tolerates a leading
   * "artist - " prefix added by other extensions.
   */
  function matchTitle(titleToId, stem) {
    if (!stem || !titleToId) return null;
    if (typeof titleToId.get === "function" && titleToId.has(stem)) return titleToId.get(stem);
    for (const [title, id] of titleToId) {
      if (!title || title.length < 6) continue;
      if (stem === title) return id;
      if (stem.endsWith(title)) {
        const prefix = stem.slice(0, stem.length - title.length);
        if (prefix.endsWith(" - ") || prefix === "- ") return id;
      }
    }
    return null;
  }

  /** Size of an ID3v2 tag (bytes after the 10-byte header), or 0 if not ID3. */
  function id3TagSize(bytes) {
    if (!bytes || bytes.length < 10) return 0;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
    return (
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f)
    );
  }

  /**
   * Best-effort clip id from the concatenated head+tail text of an audio file.
   * `knownIds` is a Set of ids already known from the feed; when present it is
   * preferred over a raw spin through the bytes.
   */
  function idFromText(text, knownIds) {
    // C2PA provenance: the content index is the clip id in both WAV and M4A.
    const c2pa = text.match(new RegExp("icontentIdx[^0-9a-f]{0,3}(" + UUID_SRC + ")", "i"));
    if (c2pa) return c2pa[1].toLowerCase();

    // "made with suno; created=...; id=<uuid>" comment (M4A ©cmt / WAV ICMT).
    // Scope the search so an unrelated "id=" elsewhere can't win.
    const comment = text.match(new RegExp("made with suno[\\s\\S]{0,180}?id[=:]\\s*(" + UUID_SRC + ")", "i"));
    if (comment) return comment[1].toLowerCase();

    const uuids = allUuids(text);
    if (knownIds && knownIds.size) {
      for (const u of uuids) if (knownIds.has(u)) return u;
    }
    const looksSuno = /com\.suno\.provenance|made with suno|suno\.com\/song/i.test(text);
    if (looksSuno && uuids.length === 1) return uuids[0];
    return null;
  }

  root.SunoGenAudioMeta = {
    AUDIO_EXT: AUDIO_EXT,
    decode: decode,
    allUuids: allUuids,
    stemOf: stemOf,
    matchTitle: matchTitle,
    id3TagSize: id3TagSize,
    idFromText: idFromText
  };
})(globalThis);
