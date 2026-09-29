const fs = require("fs");
const path = require("path");

const handle = process.argv[2] || "a666c";
const dir = process.argv[3] || path.join(process.env.HOME || "", "Downloads", handle);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAlbumDate(created) {
  if (!created) return "";
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return String(created);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function renderAlbum(account, album) {
  const posts = Object.entries(album.posts || {})
    .filter(([, post]) => Array.isArray(post.media) && post.media.length)
    .sort((a, b) => {
      try {
        return BigInt(b[0]) > BigInt(a[0]) ? 1 : -1;
      } catch (err) {
        return String(b[0]).localeCompare(String(a[0]));
      }
    });
  const empty = '<p class="text muted">No media to show yet.</p>';
  const articles = posts.map(([tweetId, post]) => {
    const mediaHtml = post.media.map((entry) => {
      const src = escapeHtml(entry.filename);
      if (entry.kind === "video") {
        return `<video controls preload="metadata" src="${src}"></video>`;
      }
      return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="" loading="lazy"></a>`;
    }).join("");
    const text = String(post.text || "").trim();
    const textHtml = text
      ? `<p class="text">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`
      : '<p class="text muted">No caption</p>';
    const when = formatAlbumDate(post.created);
    return `<article id="t${escapeHtml(tweetId)}">
  <header>
    <time>${escapeHtml(when || tweetId)}</time>
    <span class="id">${escapeHtml(tweetId)}</span>
  </header>
  ${textHtml}
  <div class="media">${mediaHtml}</div>
</article>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@${escapeHtml(account)} album</title>
<style>
  :root {
    color-scheme: light;
    --bg: #eef2f4;
    --card: #ffffff;
    --ink: #15202b;
    --muted: #5b6b79;
    --line: #d7dee5;
    --accent: #0b6e4f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 16px/1.6 "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", sans-serif;
    color: var(--ink);
    background:
      linear-gradient(180deg, #f7fafb 0%, var(--bg) 48%, #e8eef2 100%);
  }
  main {
    width: min(760px, calc(100% - 32px));
    margin: 0 auto;
    padding: 40px 0 80px;
  }
  .hero {
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--line);
  }
  .hero h1 {
    margin: 0 0 8px;
    font-size: clamp(28px, 5vw, 40px);
    letter-spacing: 0.01em;
  }
  .hero p {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }
  article {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 20px;
    margin: 0 0 18px;
  }
  article header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .id { opacity: 0.72; }
  .text {
    margin: 0 0 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .text.muted { color: var(--muted); }
  .media {
    display: grid;
    gap: 12px;
  }
  img, video {
    display: block;
    width: 100%;
    max-height: 720px;
    object-fit: contain;
    background: #e4ebf0;
    border-radius: 12px;
  }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <div class="hero">
    <h1>@${escapeHtml(account)}</h1>
    <p>${posts.length} posts · Photos and videos next to this file show below</p>
  </div>
  ${articles || empty}
</main>
</body>
</html>`;
}

const files = fs.readdirSync(dir).filter((name) => /\.(jpe?g|png|webp|gif|mp4|m4v|webm|mov)$/i.test(name));
const posts = {};
const re = /^(\d{4}-\d{2}-\d{2})_(\d{6,})_(\d+)\.([A-Za-z0-9]+)$/;
for (const filename of files) {
  const matched = filename.match(re);
  if (!matched) continue;
  const [, date, tweetId, index, ext] = matched;
  const kind = /^(mp4|m4v|webm|mov)$/i.test(ext) ? "video" : "photo";
  const created = `${date}T12:00:00`;
  if (!posts[tweetId]) posts[tweetId] = { created, text: "", media: [] };
  if (!posts[tweetId].created) posts[tweetId].created = created;
  const key = `${kind}:${tweetId}:${index}`;
  if (!posts[tweetId].media.some((entry) => entry.filename === filename)) {
    posts[tweetId].media.push({ key, filename, kind });
  }
}
for (const post of Object.values(posts)) {
  post.media.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
}

const html = renderAlbum(handle, { handle, posts });
const out = path.join(dir, "album.html");
fs.writeFileSync(out, html, "utf8");
console.log(JSON.stringify({
  out,
  files: files.length,
  posts: Object.keys(posts).length,
  bytes: Buffer.byteLength(html, "utf8"),
}, null, 2));
