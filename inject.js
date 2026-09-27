(() => {
  if (window.__xMediaDlInstalled) return;
  window.__xMediaDlInstalled = true;

  const all = [];
  const seen = new Set();
  const playlists = new Map();
  const segments = new Map();
  const segmentOrder = [];
  const finishedAssemble = new Set();
  const assembleJobs = [];
  let cacheBytes = 0;
  let assembleRunning = false;
  let assembleToken = 0;
  let assembleCurrent = "";
  const MAX_CACHE = 120 * 1024 * 1024;
  let currentPath = normalizePath(location.pathname);

  function normalizePath(path) {
    const trimmed = String(path || "").replace(/\/+$/, "");
    return trimmed || "/";
  }

  function markInstalled() {
    if (document.documentElement) {
      document.documentElement.dataset.xMediaDl = "1";
      return;
    }
    document.addEventListener("DOMContentLoaded", markInstalled, { once: true });
  }
  markInstalled();

  function keepPageDomIntact() {
    if (Node.prototype.__xMediaDomGuard) return;
    Node.prototype.__xMediaDomGuard = true;
    const removeChild = Node.prototype.removeChild;
    const insertBefore = Node.prototype.insertBefore;
    const replaceChild = Node.prototype.replaceChild;
    Node.prototype.removeChild = function (child) {
      if (!child || child.parentNode !== this) return child;
      return removeChild.call(this, child);
    };
    Node.prototype.insertBefore = function (node, ref) {
      if (ref && ref.parentNode !== this) return node;
      return insertBefore.call(this, node, ref);
    };
    Node.prototype.replaceChild = function (node, old) {
      if (!old || old.parentNode !== this) return old;
      return replaceChild.call(this, node, old);
    };
  }
  keepPageDomIntact();

  function post(message) {
    window.postMessage({ source: "x-media-dl", ...message }, "*");
  }

  function handleFromPath(path) {
    return normalizePath(path).split("/").filter(Boolean)[0] || "";
  }

  function onPathMaybeChanged() {
    const nextPath = normalizePath(location.pathname);
    if (nextPath === currentPath) return;
    const sameAccount = handleFromPath(currentPath).toLowerCase() === handleFromPath(nextPath).toLowerCase();
    currentPath = nextPath;
    if (!sameAccount) {
      all.length = 0;
      seen.clear();
      clearStreamCache();
    }
    post({ type: "reset", sameAccount });
  }

  function hookHistory() {
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function () {
        const result = original.apply(this, arguments);
        try {
          onPathMaybeChanged();
        } catch (err) {
          /* 页面路由失败不影响 X 本身 */
        }
        return result;
      };
    }
    window.addEventListener("popstate", () => {
      try {
        onPathMaybeChanged();
      } catch (err) {
        /* ignore */
      }
    });
  }
  hookHistory();

  function operationName(url) {
    try {
      const parsed = new URL(url, location.origin);
      return parsed.searchParams.get("operationName") || parsed.pathname.split("/").filter(Boolean).pop() || "";
    } catch (err) {
      return "";
    }
  }

  function shouldPublish(url) {
    if (!/\/graphql\//i.test(String(url || ""))) return false;
    const name = operationName(url);
    if (/Typeahead|BadgeCount|Viewer|UsersByRestIds|PinnedTimelines/i.test(name)) return false;
    return true;
  }

  function publish(url, data) {
    setTimeout(() => {
      try {
        if (!shouldPublish(url) || !data) return;
        const items = [];
        walk(data, { tweetId: "", created: "", author: "" }, items, 0);
        if (!items.length) return;
        all.push(...items);
        post({ type: "media", items });
      } catch (err) {
        /* 解析失败时不影响页面自己的加载 */
      }
    }, 0);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "x-media-dl") return;
    if (event.data.type === "pull") post({ type: "media", items: all.slice() });
    if (event.data.type === "assemble" && event.data.item) enqueueAssemble(event.data.item, event.data.epoch);
    if (event.data.type === "assemble-stop") {
      assembleToken += 1;
      assembleJobs.length = 0;
      assembleCurrent = "";
    }
  });

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const pending = originalFetch.apply(this, arguments);
    return pending.then((response) => {
      try {
        const url = response.url || (typeof input === "string" ? input : input?.url) || "";
        if (shouldPublish(url)) {
          response.clone().json().then((data) => publish(url, data)).catch(() => {});
        } else {
          captureResponse(response, url);
        }
      } catch (err) {
        /* 读取响应失败时把原始响应原样交还页面 */
      }
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xMediaUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        const url = String(this.__xMediaUrl || this.responseURL || "");
        if (shouldPublish(url)) {
          if (this.responseType === "json") {
            publish(url, this.response);
            return;
          }
          if (this.responseType && this.responseType !== "text") return;
          publish(url, JSON.parse(this.responseText));
          return;
        }
        captureXhr(this, url);
      } catch (err) {
        /* ignore */
      }
    });
    return originalSend.apply(this, arguments);
  };

  function isTweetNode(node) {
    const typeName = node.__typename;
    if (typeName === "Tweet" || typeName === "TweetWithVisibilityResults") return true;
    const legacy = node.legacy;
    return !!(legacy && (typeof legacy.full_text === "string" || legacy.extended_entities));
  }

  function authorOf(node) {
    const user = node?.core?.user_results?.result || node?.user_results?.result;
    return user?.legacy?.screen_name || user?.core?.screen_name || user?.screen_name || "";
  }

  function mediaLists(node) {
    const extended = node.extended_entities?.media || node.legacy?.extended_entities?.media;
    if (Array.isArray(extended) && extended.length) return [extended];
    const basic = node.entities?.media || node.legacy?.entities?.media;
    if (Array.isArray(basic) && basic.length) return [basic];
    return [];
  }

  function walk(node, ctx, out, depth) {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx, out, depth + 1);
      return;
    }

    let local = ctx;
    if (isTweetNode(node)) {
      local = {
        tweetId: /^\d{5,}$/.test(node.rest_id || "") ? node.rest_id : ctx.tweetId,
        created: node.legacy?.created_at || ctx.created || "",
        author: authorOf(node) || ctx.author || "",
      };
    }

    for (const list of mediaLists(node)) {
      list.forEach((media, index) => collect(media, local, index + 1, out));
    }
    if (typeof node.media_url_https === "string" || Array.isArray(node.video_info?.variants)) {
      collect(node, local, 1, out);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value, local, out, depth + 1);
    }
  }

  function hostUrl(raw, host) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== host) return "";
      return url.toString();
    } catch (err) {
      return "";
    }
  }

  function photoUrl(raw) {
    const url = hostUrl(raw, "pbs.twimg.com");
    if (!url || !/\/media\//.test(url)) return "";
    const parsed = new URL(url);
    parsed.searchParams.set("name", "orig");
    return parsed.toString();
  }

  function photoKey(url) {
    const matched = url.match(/\/media\/([^/?]+)/);
    if (!matched) return "";
    return matched[1].replace(/\.(jpe?g|png|webp)$/i, "");
  }

  function extOf(url, fallback) {
    try {
      const parsed = new URL(url);
      const format = parsed.searchParams.get("format");
      if (format && /^[a-z0-9]+$/i.test(format)) return format.toLowerCase();
      const matched = parsed.pathname.match(/\.([a-z0-9]+)$/i);
      if (matched) return matched[1].toLowerCase();
    } catch (err) {
      /* use fallback */
    }
    return fallback;
  }

  function collect(media, ctx, index, out) {
    if (!media || typeof media !== "object") return;
    const mediaKey = String(media.media_key || media.id_str || "");
    const type = media.type;

    if (type === "video" || type === "animated_gif") {
      const variants = Array.isArray(media.video_info?.variants) ? media.video_info.variants : [];
      const mp4 = variants
        .filter((variant) => variant && variant.content_type === "video/mp4" && typeof variant.url === "string")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!mp4) {
        const playlist = variants.find((variant) => variant && typeof variant.url === "string" && (/mpegurl/i.test(variant.content_type || "") || /\.m3u8(\?|$)/i.test(variant.url)));
        const playlistUrl = playlist && hostUrl(playlist.url, "video.twimg.com");
        if (!playlistUrl) {
          pushSkipped(out, `skip:${mediaKey || index}`, ctx);
          return;
        }
        pushItem(out, {
          key: `video:${mediaKey || playlistUrl}`,
          kind: "stream",
          playlistUrl,
          ext: "ts",
          author: ctx.author || "",
          tweetId: ctx.tweetId || "",
          created: ctx.created || "",
          index,
        });
        return;
      }
      const url = hostUrl(mp4.url, "video.twimg.com");
      if (!url) return;
      pushItem(out, {
        key: `video:${mediaKey || url}`,
        url,
        kind: "video",
        ext: "mp4",
        author: ctx.author || "",
        tweetId: ctx.tweetId || "",
        created: ctx.created || "",
        index,
      });
      return;
    }

    if (type && type !== "photo") return;
    const url = photoUrl(media.media_url_https);
    const id = url && photoKey(url);
    if (!id) return;
    pushItem(out, {
      key: `photo:${id}`,
      url,
      kind: "photo",
      ext: extOf(url, "jpg"),
      author: ctx.author || "",
      tweetId: ctx.tweetId || "",
      created: ctx.created || "",
      index,
    });
  }

  function pushSkipped(out, key, ctx) {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ skipped: true, key, author: ctx?.author || "" });
  }

  function pushItem(out, item) {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  }

  function clearStreamCache() {
    playlists.clear();
    segments.clear();
    segmentOrder.length = 0;
    cacheBytes = 0;
    assembleJobs.length = 0;
    assembleToken += 1;
    assembleCurrent = "";
  }

  function cacheKey(url) {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  }

  function isVideoHost(url) {
    try {
      return new URL(url).hostname === "video.twimg.com";
    } catch (err) {
      return false;
    }
  }

  function isPlaylistUrl(url, contentType) {
    return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType || "");
  }

  function isSegmentUrl(url, contentType, length) {
    if (!isVideoHost(url) || isPlaylistUrl(url, contentType)) return false;
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch (err) {
      return false;
    }
    if (/\.(ts|m4s|aac)$/i.test(path)) return !length || length < 30 * 1024 * 1024;
    if (/\.mp4$/i.test(path)) return length > 0 && length < 8 * 1024 * 1024;
    return false;
  }

  function storeSegment(url, buffer) {
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > 30 * 1024 * 1024) return;
    const key = cacheKey(url);
    if (segments.has(key)) return;
    let guard = segmentOrder.length + 1;
    while (cacheBytes + buffer.byteLength > MAX_CACHE && segmentOrder.length && guard > 0) {
      guard -= 1;
      const old = segmentOrder.shift();
      const prev = segments.get(old);
      segments.delete(old);
      if (prev) cacheBytes -= prev.byteLength;
    }
    if (cacheBytes + buffer.byteLength > MAX_CACHE) return;
    segments.set(key, buffer);
    segmentOrder.push(key);
    cacheBytes += buffer.byteLength;
  }

  function captureResponse(response, url) {
    if (!isVideoHost(url)) return;
    const contentType = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (isPlaylistUrl(url, contentType)) {
      response.clone().text().then((text) => {
        if (text) playlists.set(cacheKey(url), text);
      }).catch(() => {});
      return;
    }
    if (!isSegmentUrl(url, contentType, length)) return;
    response.clone().arrayBuffer().then((buffer) => storeSegment(url, buffer)).catch(() => {});
  }

  function captureXhr(xhr, url) {
    if (!isVideoHost(url)) return;
    const contentType = xhr.getResponseHeader("content-type") || "";
    const length = Number(xhr.getResponseHeader("content-length") || 0);
    if (isPlaylistUrl(url, contentType)) {
      const text = xhr.responseType && xhr.responseType !== "text" ? "" : xhr.responseText;
      if (text) playlists.set(cacheKey(url), text);
      return;
    }
    if (!isSegmentUrl(url, contentType, length)) return;
    if (xhr.responseType === "arraybuffer" && xhr.response) storeSegment(url, xhr.response);
    else if (xhr.responseType === "blob" && xhr.response) {
      xhr.response.arrayBuffer().then((buffer) => storeSegment(url, buffer)).catch(() => {});
    }
  }

  function resolveUrl(raw, base) {
    try {
      return new URL(raw, base).toString();
    } catch (err) {
      return "";
    }
  }

  function parsePlaylist(text, baseUrl) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants = [];
    const parts = [];
    let initUrl = "";
    let encrypted = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(line)) encrypted = true;
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const bandwidth = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        const uri = lines[i + 1];
        if (uri && !uri.startsWith("#")) variants.push({ bandwidth, url: resolveUrl(uri, baseUrl) });
      } else if (line.startsWith("#EXT-X-MAP")) {
        const uri = (line.match(/URI="([^"]+)"/) || [])[1];
        if (uri) initUrl = resolveUrl(uri, baseUrl);
      } else if (line.startsWith("#EXTINF")) {
        const uri = lines[i + 1];
        if (uri && !uri.startsWith("#")) {
          const absolute = resolveUrl(uri, baseUrl);
          if (absolute) parts.push(absolute);
        }
      }
    }
    return { variants, parts, initUrl, encrypted };
  }

  async function playlistText(url) {
    const key = cacheKey(url);
    if (playlists.has(key)) return playlists.get(key);
    const response = await originalFetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(String(response.status));
    const text = await response.text();
    playlists.set(key, text);
    return text;
  }

  async function loadPlaylist(url, depth) {
    if (!isVideoHost(url)) throw new Error("host");
    if (depth > 3) throw new Error("playlist");
    const parsed = parsePlaylist(await playlistText(url), url);
    if (parsed.encrypted) throw new Error("encrypted");
    if (parsed.parts.length || parsed.initUrl) return parsed;
    const best = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!best?.url) throw new Error("empty");
    return loadPlaylist(best.url, depth + 1);
  }

  async function loadSegment(url) {
    const key = cacheKey(url);
    if (segments.has(key)) return segments.get(key);
    const response = await originalFetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(String(response.status));
    const buffer = await response.arrayBuffer();
    storeSegment(url, buffer);
    return buffer;
  }

  function containerExt(initUrl, parts) {
    if (initUrl) return "mp4";
    const sample = parts[0] || "";
    if (/\.(m4s|mp4)(\?|$)/i.test(sample)) return "mp4";
    return "ts";
  }

  function emitFile(meta, pieces, token) {
    if (token !== assembleToken) return;
    const chunkSize = 512 * 1024;
    post({ type: "stream-start", epoch: meta.epoch, file: meta });
    for (const buffer of pieces) {
      for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
        if (token !== assembleToken) return;
        post({
          type: "stream-chunk",
          epoch: meta.epoch,
          key: meta.key,
          solo: meta.solo === true,
          buffer: buffer.slice(offset, Math.min(offset + chunkSize, buffer.byteLength)),
        });
      }
    }
    if (token !== assembleToken) return;
    post({ type: "stream-end", epoch: meta.epoch, key: meta.key, solo: meta.solo === true });
  }

  function enqueueAssemble(item, epoch) {
    if (!item?.key || !item.playlistUrl || finishedAssemble.has(item.key)) return;
    if (assembleCurrent === item.key || assembleJobs.some((job) => job.item.key === item.key)) return;
    assembleJobs.push({ item, epoch });
    pumpAssemble();
  }

  async function pumpAssemble() {
    if (assembleRunning) return;
    assembleRunning = true;
    while (assembleJobs.length) {
      const job = assembleJobs.shift();
      const token = assembleToken;
      assembleCurrent = job.item.key;
      try {
        await assemble(job.item, job.epoch, token);
        if (token === assembleToken) finishedAssemble.add(job.item.key);
      } catch (err) {
        if (token === assembleToken) {
          post({ type: "stream-fail", epoch: job.epoch, key: job.item.key, solo: job.item.solo === true });
        }
      } finally {
        if (assembleCurrent === job.item.key) assembleCurrent = "";
      }
    }
    assembleRunning = false;
  }

  async function assemble(item, epoch, token) {
    const playlist = await loadPlaylist(item.playlistUrl, 0);
    if (token !== assembleToken) return;
    const urls = [];
    if (playlist.initUrl) urls.push(playlist.initUrl);
    urls.push(...playlist.parts);
    if (!urls.length) throw new Error("empty");
    const cached = urls.filter((url) => segments.has(cacheKey(url))).length;
    if (cached > 0 && cached < urls.length) {
      const waitUntil = Date.now() + 4000;
      while (Date.now() < waitUntil) {
        if (token !== assembleToken) return;
        if (urls.every((url) => segments.has(cacheKey(url)))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const pieces = new Array(urls.length);
    let cursor = 0;
    let got = 0;
    async function worker() {
      while (cursor < urls.length) {
        if (token !== assembleToken) return;
        const index = cursor;
        cursor += 1;
        pieces[index] = await loadSegment(urls[index]);
        got += 1;
        if (got === urls.length || got % 4 === 0) {
          post({ type: "stream-progress", epoch, key: item.key, got, total: urls.length });
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (token !== assembleToken) return;
    if (pieces.some((piece) => !piece)) throw new Error("segment");
    emitFile({
      key: item.key,
      author: item.author || "",
      tweetId: item.tweetId || "",
      created: item.created || "",
      index: item.index || 1,
      ext: containerExt(playlist.initUrl, playlist.parts),
      epoch,
      solo: item.solo === true,
      folder: item.folder || "",
      trackCursor: item.trackCursor !== false,
    }, pieces, token);
    for (const url of urls) {
      const key = cacheKey(url);
      const prev = segments.get(key);
      if (prev) cacheBytes -= prev.byteLength;
      segments.delete(key);
    }
  }
})();
