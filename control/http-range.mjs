// HTTP Range support shared by the recordings and exports endpoints — both
// need to stream large MP4s to a `<video>` (Safari requires Range to seek) and
// a `download` link the same way.
import { statSync, createReadStream } from 'node:fs';

// Parse a Range header into {start, end} (inclusive, both clamped to the file).
// Handles `bytes=A-B`, `bytes=A-` (open end), and `bytes=-N` (the suffix form:
// last N bytes — the source of the bug this helper exists to share).
// Returns null for a missing/malformed header (caller falls back to 200), or
// {error: 416} for an unsatisfiable range.
export function parseRange(headerValue, total) {
  if (!headerValue) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerValue);
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) {                  // suffix form: bytes=-N -> last N bytes
    if (end === null) return null;
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) return { error: 416 };
  return { start, end };
}

// Stream `file` with optional Range. `headers` are merged into every response
// (e.g. content-type, content-disposition). Returns true once a response is
// committed (so callers can `if (!served) send404()`).
export function serveRangedFile(file, req, res, headers) {
  const total = statSync(file).size;
  const base = { 'accept-ranges': 'bytes', ...headers };
  const r = parseRange(req.headers.range, total);
  if (r && r.error === 416) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    res.end();
    return true;
  }
  if (r) {
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${r.start}-${r.end}/${total}`,
      'content-length': r.end - r.start + 1,
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file, { start: r.start, end: r.end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, 'content-length': total });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}
