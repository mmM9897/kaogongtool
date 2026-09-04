#!/usr/bin/env node
/**
 * server.js — 公考时政平台本地服务器
 * 同时提供静态文件服务和时政抓取API
 * 运行: node server.js  然后浏览器打开 http://localhost:8766
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const url = require("url");

const PORT = 8766;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "daily_articles.js");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PEOPLE_BASE = "http://opinion.people.com.cn";

// ============ 文章抓取逻辑 ============

// 检测系统代理
const PROXY_HOST = process.env.HTTP_PROXY || process.env.http_proxy || "";
const PROXY = PROXY_HOST ? (() => { try { const u = new URL(PROXY_HOST); return { host: u.hostname, port: u.port || 80 }; } catch(e) { return null; } })() : null;

function fetchUrl(targetUrl) {
  return new Promise((resolve) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    let options;
    if (PROXY && !isHttps) {
      // HTTP通过代理：发送完整URL
      options = {
        hostname: PROXY.host,
        port: PROXY.port,
        path: targetUrl,
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          Host: parsed.host,
        },
        timeout: 20000,
      };
    } else if (PROXY && isHttps) {
      // HTTPS通过代理：使用CONNECT隧道
      options = {
        hostname: PROXY.host,
        port: PROXY.port,
        path: targetUrl,
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          Host: parsed.host,
        },
        timeout: 20000,
      };
    } else {
      // 直连
      options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Accept-Encoding": "gzip, deflate",
        },
        timeout: 20000,
      };
    }
    const req = mod.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        let data = Buffer.concat(chunks);
        try {
          const enc = resp.headers["content-encoding"];
          if (enc === "gzip" || (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)) data = zlib.gunzipSync(data);
          else if (enc === "deflate") data = zlib.inflateSync(data);
        } catch (e) {}
        resolve(data.toString("utf-8"));
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function stripHtml(text) {
  text = text.replace(/<script[^>]*>.*?<\/script>/gis, "");
  text = text.replace(/<style[^>]*>.*?<\/style>/gis, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "\n").replace(/<\/p>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  text = text.replace(/&ldquo;/g, "\u201c").replace(/&rdquo;/g, "\u201d");
  text = text.replace(/&hellip;/g, "\u2026");
  text = text.replace(/&#(\d+);/g, (m, c) => String.fromCharCode(parseInt(c)));
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function extractTitle(html) {
  let m = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (m && stripHtml(m[1]).trim()) return stripHtml(m[1]).trim();
  m = html.match(/<title>(.*?)<\/title>/is);
  if (m) {
    let t = stripHtml(m[1]).trim();
    for (const sep of ["_", "--", "-", "|"]) { if (t.includes(sep)) { const p = t.split(sep); if (p[0].trim()) return p[0].trim(); } }
    return t;
  }
  return "";
}

function extractContent(html) {
  let m = html.match(/id="rm_txt_zw"[^>]*>(.*?)(?:<div class="edit|<div class="zdfy|<!--)/is);
  if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  for (const cls of ["rm_txt_con", "TRS_Editor", "box_con", "content"]) {
    m = html.match(new RegExp(`<div[^>]*class="[^"]*${cls}[^"]*"[^>]*>(.*?)(?:</div>\\s*<div)`, "is"));
    if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  }
  const paras = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
  const clean = paras.map(p => stripHtml(p[1]).trim()).filter(t => t.length > 20);
  return clean.length > 0 && clean.join("\n\n").length > 200 ? clean.join("\n\n") : "";
}

function extractSummary(content, maxLen = 250) {
  if (!content) return "";
  const paras = content.split("\n\n").filter(p => p.trim());
  let s = "";
  for (const p of paras) { if (s.length + p.length <= maxLen) s += p; else { const r = maxLen - s.length; if (r > 30) s += p.substring(0, r) + "..."; break; } }
  return s || content.substring(0, maxLen) + "...";
}

function extractDateFromUrl(u) {
  const m = u.match(/\/(\d{4})\/(\d{4})\//);
  return m ? `${m[1]}-${m[2].substring(0,2)}-${m[2].substring(2)}` : "";
}

function extractTags(title, content) {
  const kw = { "经济":["经济","GDP","消费","投资","产业","贸易"], "科技":["科技","AI","创新","技术","数字","芯片"], "民生":["民生","就业","医疗","教育","养老","住房","食品安全"], "治理":["治理","基层","法治","监管","执法"], "生态":["生态","环保","绿色","低碳","环境"], "文化":["文化","文明","旅游","艺术"], "国际":["国际","外交","关税","中美","全球","制裁"], "乡村振兴":["乡村","农业","农村","农民","脱贫","粮食"], "高质量发展":["高质量","新质生产力","改革","发展"] };
  const tags = []; const text = title + " " + content.substring(0, 500);
  for (const [t, ks] of Object.entries(kw)) { for (const k of ks) { if (text.includes(k)) { if (!tags.includes(t)) tags.push(t); break; } } }
  return tags.length > 0 ? tags.slice(0, 3) : ["时政"];
}

function findArticleLinks(listHtml, targetDate) {
  const links = [...listHtml.matchAll(/\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html/g)].map(m => m[0]);
  const result = []; const seen = new Set();
  for (const link of links) { if (seen.has(link)) continue; seen.add(link); if (extractDateFromUrl(link) === targetDate) result.push(PEOPLE_BASE + link); }
  return result;
}

// 全局已抓取URL去重
const fetchedUrls = new Set();

async function fetchArticleUnique(u, sourceName, targetDate) {
  if (fetchedUrls.has(u)) return null;
  fetchedUrls.add(u);
  return await fetchArticle(u, sourceName, targetDate);
}

// 半月谈文章解析
function extractBanyuetanTitle(html) {
  let m = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (m) return stripHtml(m[1]).trim();
  m = html.match(/<title>(.*?)<\/title>/is);
  if (m) { let t = stripHtml(m[1]).trim(); if (t.includes("-半月谈")) t = t.replace(/-半月谈.*$/, ""); return t; }
  return "";
}

function extractBanyuetanContent(html) {
  // 半月谈正文在 detail_left 或 image_text 容器中
  let m = html.match(/<div[^>]*class="[^"]*image_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/i);
  if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  m = html.match(/<div[^>]*class="[^"]*detail_left[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/i);
  if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  // 通用p标签提取
  const paras = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
  const clean = paras.map(p => stripHtml(p[1]).trim()).filter(t => t.length > 20);
  return clean.length > 0 && clean.join("\n\n").length > 200 ? clean.join("\n\n") : "";
}

function extractBanyuetanSource(html) {
  const m = html.match(/<div[^>]*class="[^"]*detail_tit_source[^"]*"[^>]*>(.*?)<\/div>/is);
  if (m) { const t = stripHtml(m[1]).trim(); if (t) return t; }
  return "半月谈";
}

async function fetchBanyuetanArticle(u, targetDate) {
  if (fetchedUrls.has(u)) return null;
  fetchedUrls.add(u);
  const html = await fetchUrl(u);
  if (!html) return null;
  const title = extractBanyuetanTitle(html);
  const content = extractBanyuetanContent(html);
  if (!title || content.length < 100) return null;
  // 过滤商业/财报类文章
  const bizKeywords = ["半年报", "年报", "财报", "净利润", "营业收入", "股票代码", "毛利率", "市值", "营收", "同比增"];
  if (bizKeywords.some(k => title.includes(k) || content.substring(0, 300).includes(k))) return null;
  let source = extractBanyuetanSource(html);
  // 清理来源字段
  source = source.replace(/^来源：/, "").trim();
  if (!source || source.length > 20) source = "半月谈";
  return { title, source, date: targetDate, url: u, summary: extractSummary(content), content, tags: extractTags(title, content) };
}

// 从半月谈列表页提取文章链接
function findBanyuetanLinks(listHtml, targetDateCompact) {
  // targetDateCompact 格式如 "20260826"
  const pattern = new RegExp("href=\"(https?://www\\.banyuetan\\.org/[^\"]*" + targetDateCompact + "[^\"]*\\.html)\"", "g");
  const links = [...listHtml.matchAll(pattern)].map(m => m[1]);
  return [...new Set(links)];
}

async function fetchArticle(u, sourceName, targetDate) {
  const html = await fetchUrl(u);
  if (!html) return null;
  const title = extractTitle(html);
  const content = extractContent(html);
  if (!title || content.length < 100) return null;
  return { title, source: sourceName, date: targetDate, url: u, summary: extractSummary(content), content, tags: extractTags(title, content) };
}

function generateJs(articles, todayDate) {
  const lines = [];
  lines.push("/* daily_articles.js — 每日时政文章数据（自动抓取生成）");
  lines.push(` * 生成时间: ${new Date().toLocaleString("zh-CN")}`);
  if (articles.length > 0) lines.push(` * 文章日期: ${articles[0].date}`);
  lines.push(" */");
  lines.push("window.DAILY_ARTICLES = {");
  lines.push(`  date: "${todayDate}",`);
  lines.push("  articles: [");
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const title = a.title.replace(/`/g, "'").replace(/\\/g, "");
    const summary = a.summary.replace(/`/g, "'").replace(/\\/g, "");
    const content = a.content.replace(/`/g, "'").replace(/\\/g, "").replace(/\n/g, "\\n");
    const tagsStr = a.tags.map(t => `"${t}"`).join(", ");
    lines.push("    {");
    lines.push(`      id: ${i+1}, title: \`${title}\`, source: \`${a.source}\`, date: \`${a.date}\`, url: \`${a.url}\`,`);
    lines.push(`      summary: \`${summary}\`, content: \`${content}\`, tags: [${tagsStr}], likes: 0`);
    lines.push("    }" + (i < articles.length - 1 ? "," : ""));
  }
  lines.push("  ]");
  lines.push("};");
  return lines.join("\n");
}

async function doRefreshArticles() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,"0")}-${String(yesterday.getDate()).padStart(2,"0")}`;

  const allArticles = [];

  // ====== 人民网评论频道（公考核心来源）======
  // 来源1: 人民网观点频道首页（人民时评、人民锐评等）
  let listHtml = await fetchUrl(`${PEOPLE_BASE}/GB/159301/`);
  if (listHtml) {
    const links = findArticleLinks(listHtml, yesterdayStr);
    for (const link of links) { if (allArticles.length >= 15) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); }
  }
  // 来源2: 观点频道第2页
  if (allArticles.length < 12) {
    const h2 = await fetchUrl(`${PEOPLE_BASE}/GB/159301/index2.html`);
    if (h2) { const l2 = findArticleLinks(h2, yesterdayStr); for (const link of l2) { if (allArticles.length >= 15) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源3: 人民日报观点频道
  if (allArticles.length < 12) {
    const h3 = await fetchUrl(`${PEOPLE_BASE}/GB/223228/`);
    if (h3) { const l3 = findArticleLinks(h3, yesterdayStr); for (const link of l3) { if (allArticles.length >= 15) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源4: 环球网评
  if (allArticles.length < 12) {
    const h4 = await fetchUrl(`${PEOPLE_BASE}/GB/462004/`);
    if (h4) { const l4 = findArticleLinks(h4, yesterdayStr); for (const link of l4) { if (allArticles.length >= 15) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源5: 人民网评
  if (allArticles.length < 12) {
    const h5 = await fetchUrl(`${PEOPLE_BASE}/GB/436867/`);
    if (h5) { const l5 = findArticleLinks(h5, yesterdayStr); for (const link of l5) { if (allArticles.length >= 15) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }

  // ====== 半月谈（公考核心来源）======
  // 将 yesterdayStr "2026-08-26" 转为 "20260826" 格式
  const yDateCompact = yesterdayStr.replace(/-/g, "");
  // 来源6: 半月谈首页（含今日谈、思想建设、民生话题等板块）
  if (allArticles.length < 15) {
    const btHtml = await fetchUrl("http://www.banyuetan.org/");
    if (btHtml) {
      const btLinks = findBanyuetanLinks(btHtml, yDateCompact);
      for (const link of btLinks) {
        if (allArticles.length >= 15) break;
        // 过滤掉商业评论类文章
        if (link.includes("/ppzx/")) continue;
        const a = await fetchBanyuetanArticle(link, yesterdayStr);
        if (a) allArticles.push(a);
      }
    }
  }
  // 来源7: 半月谈今日谈板块
  if (allArticles.length < 15) {
    const btJrt = await fetchUrl("http://www.banyuetan.org/jrt/");
    if (btJrt) {
      const btLinks = findBanyuetanLinks(btJrt, yDateCompact);
      for (const link of btLinks) {
        if (allArticles.length >= 15) break;
        const a = await fetchBanyuetanArticle(link, yesterdayStr);
        if (a) allArticles.push(a);
      }
    }
  }

  if (allArticles.length < 1) return { updated: false, count: 0, message: "未抓取到文章，保留旧数据" };

  if (fs.existsSync(DATA_FILE)) { try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch (e) {} }
  const jsContent = generateJs(allArticles, today);
  try {
    fs.writeFileSync(DATA_FILE, jsContent, "utf-8");
    return { updated: true, count: allArticles.length, message: `成功抓取 ${allArticles.length} 篇文章，文章日期: ${yesterdayStr}` };
  } catch (e) {
    return { updated: false, count: 0, message: `写入失败: ${e.message}` };
  }
}

// ============ HTTP 服务器 ============

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".bat": "text/plain", ".txt": "text/plain; charset=utf-8", ".md": "text/plain",
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ===== API: 抓取文章 =====
  if (pathname === "/api/refresh-articles") {
    console.log(`[API] ${new Date().toLocaleTimeString()} 收到更新请求`);
    try {
      const result = await doRefreshArticles();
      console.log(`[API] 结果: ${result.message}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ updated: false, count: 0, message: "服务器错误: " + e.message }));
    }
    return;
  }

  // ===== 静态文件服务 =====
  let filePath = path.join(ROOT, pathname === "/" ? "gongkao-platform.html" : pathname);
  // 防止目录穿越
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404 - 文件不存在</h1><p>请确保通过 <code>node server.js</code> 启动服务器</p>");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("  公考时政平台已启动");
  console.log("  浏览器打开: http://localhost:" + PORT);
  console.log("  点击'时政积累' -> '更新时政'按钮即可刷新文章");
  console.log("  API地址: http://localhost:" + PORT + "/api/refresh-articles");
  console.log("  按 Ctrl+C 停止服务器");
  console.log("=".repeat(50));
});

// 防止崩溃：捕获未处理的错误
process.on('uncaughtException', (err) => {
  console.error('[错误捕获]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[Promise错误]', err);
});
