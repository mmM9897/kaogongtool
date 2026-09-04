const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

// ============ 自动抓取文章功能 ============
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PEOPLE_BASE = "http://opinion.people.com.cn";
const DATA_FILE = path.join(__dirname, "daily_articles.js");

function fetchUrl(url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const options = {
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

function extractDateFromUrl(url) {
  const m = url.match(/\/(\d{4})\/(\d{4})\//);
  return m ? `${m[1]}-${m[2].substring(0,2)}-${m[2].substring(2)}` : "";
}

function extractTags(title, content) {
  const kw = { "经济":["经济","GDP","消费","投资","产业","贸易"], "科技":["科技","AI","创新","技术","数字","芯片"], "民生":["民生","就业","医疗","教育","养老","住房","食品安全"], "治理":["治理","基层","法治","监管","执法"], "生态":["生态","环保","绿色","低碳","环境"], "文化":["文化","文明","旅游","艺术"], "国际":["国际","外交","关税","中美","全球","制裁"], "高质量发展":["高质量","新质生产力","改革","发展"] };
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

async function fetchArticle(url, sourceName, targetDate) {
  const html = await fetchUrl(url);
  if (!html) return null;
  const title = extractTitle(html);
  const content = extractContent(html);
  if (!title || content.length < 100) return null;
  return { title, source: sourceName, date: targetDate, url, summary: extractSummary(content), content, tags: extractTags(title, content) };
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
  let m = html.match(/<div[^>]*class="[^"]*image_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/i);
  if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  m = html.match(/<div[^>]*class="[^"]*detail_left[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/i);
  if (m) { const t = stripHtml(m[1]); if (t.length > 200) return t; }
  const paras = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
  const clean = paras.map(p => stripHtml(p[1]).trim()).filter(t => t.length > 20);
  return clean.length > 0 && clean.join("\n\n").length > 200 ? clean.join("\n\n") : "";
}
async function fetchBanyuetanArticle(u, targetDate) {
  if (fetchedUrls.has(u)) return null;
  fetchedUrls.add(u);
  const html = await fetchUrl(u);
  if (!html) return null;
  const title = extractBanyuetanTitle(html);
  const content = extractBanyuetanContent(html);
  if (!title || content.length < 100) return null;
  const bizKeywords = ["半年报","年报","财报","净利润","营业收入","股票代码","毛利率","市值","营收","同比增"];
  if (bizKeywords.some(k => title.includes(k) || content.substring(0,300).includes(k))) return null;
  let source = "半月谈";
  const sm = html.match(/<div[^>]*class="[^"]*detail_tit_source[^"]*"[^>]*>(.*?)<\/div>/is);
  if (sm) { source = stripHtml(sm[1]).trim().replace(/^来源：/,"").trim(); if (!source || source.length > 20) source = "半月谈"; }
  return { title, source, date: targetDate, url: u, summary: extractSummary(content), content, tags: extractTags(title, content) };
}
function findBanyuetanLinks(listHtml, targetDateCompact) {
  const pattern = new RegExp("href=\"(https?://www\\.banyuetan\\.org/[^\"]*" + targetDateCompact + "[^\"]*\\.html)\"", "g");
  return [...new Set([...listHtml.matchAll(pattern)].map(m => m[1]))];
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

function getDataFileDate() {
  try {
    const content = fs.readFileSync(DATA_FILE, "utf-8");
    const m = content.match(/date:\s*"(\d{4}-\d{2}-\d{2})"/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}

async function autoUpdateArticles(force = false) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const fileDate = getDataFileDate();
  
  // 如果数据已经是今天的，不需要更新（除非强制）
  if (!force && fileDate === today) {
    console.log("[自动更新] 数据已是最新，无需更新");
    return { updated: false, count: 0, message: "数据已是最新，无需更新" };
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,"0")}-${String(yesterday.getDate()).padStart(2,"0")}`;
  
  console.log(`[自动更新] 开始抓取 ${yesterdayStr} 的文章...`);
  
  const allArticles = [];
  const fetchedUrls = new Set();
  async function fetchArticleUnique(u, src, dt) { if (fetchedUrls.has(u)) return null; fetchedUrls.add(u); return await fetchArticle(u, src, dt); }
  const TARGET = 15;
  
  // ====== 人民网评论频道（公考核心来源）======
  // 来源1: 人民网观点频道
  let listHtml = await fetchUrl(`${PEOPLE_BASE}/GB/159301/`);
  if (listHtml) {
    const links = findArticleLinks(listHtml, yesterdayStr);
    for (const link of links) { if (allArticles.length >= TARGET) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); }
  }
  // 来源2: 观点第2页
  if (allArticles.length < 12) {
    const h2 = await fetchUrl(`${PEOPLE_BASE}/GB/159301/index2.html`);
    if (h2) { const l2 = findArticleLinks(h2, yesterdayStr); for (const link of l2) { if (allArticles.length >= TARGET) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源3: 人民日报观点
  if (allArticles.length < 12) {
    const h3 = await fetchUrl(`${PEOPLE_BASE}/GB/223228/`);
    if (h3) { const l3 = findArticleLinks(h3, yesterdayStr); for (const link of l3) { if (allArticles.length >= TARGET) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源4: 环球网评
  if (allArticles.length < 12) {
    const h4 = await fetchUrl(`${PEOPLE_BASE}/GB/462004/`);
    if (h4) { const l4 = findArticleLinks(h4, yesterdayStr); for (const link of l4) { if (allArticles.length >= TARGET) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源5: 人民网评
  if (allArticles.length < 12) {
    const h5 = await fetchUrl(`${PEOPLE_BASE}/GB/436867/`);
    if (h5) { const l5 = findArticleLinks(h5, yesterdayStr); for (const link of l5) { if (allArticles.length >= TARGET) break; const a = await fetchArticleUnique(link, "人民网", yesterdayStr); if (a) allArticles.push(a); } }
  }

  // ====== 半月谈（公考核心来源）======
  const yDateCompact = yesterdayStr.replace(/-/g, "");
  // 来源6: 半月谈首页
  if (allArticles.length < 15) {
    const btHtml = await fetchUrl("http://www.banyuetan.org/");
    if (btHtml) { const btLinks = findBanyuetanLinks(btHtml, yDateCompact); for (const link of btLinks) { if (allArticles.length >= TARGET) break; if (link.includes("/ppzx/")) continue; const a = await fetchBanyuetanArticle(link, yesterdayStr); if (a) allArticles.push(a); } }
  }
  // 来源7: 半月谈今日谈
  if (allArticles.length < 15) {
    const btJrt = await fetchUrl("http://www.banyuetan.org/jrt/");
    if (btJrt) { const btLinks = findBanyuetanLinks(btJrt, yDateCompact); for (const link of btLinks) { if (allArticles.length >= TARGET) break; const a = await fetchBanyuetanArticle(link, yesterdayStr); if (a) allArticles.push(a); } }
  }
  
  console.log(`[自动更新] 抓取到 ${allArticles.length} 篇文章`);
  
  if (allArticles.length < 1) {
    console.log("[自动更新] 未抓取到文章，保留旧数据");
    return { updated: false, count: 0, message: "未抓取到文章，保留旧数据" };
  }
  
  // 备份旧文件
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch (e) {}
  }
  
  const jsContent = generateJs(allArticles, today);
  try {
    fs.writeFileSync(DATA_FILE, jsContent, "utf-8");
    console.log(`[自动更新] 已更新文章数据，文章日期: ${yesterdayStr}`);
    return { updated: true, count: allArticles.length, message: `成功抓取 ${allArticles.length} 篇文章，文章日期: ${yesterdayStr}` };
  } catch (e) {
    console.log(`[自动更新] 写入失败: ${e.message}`);
    return { updated: false, count: 0, message: `写入失败: ${e.message}` };
  }
}

// ============ Electron 主窗口 ============

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 720,
    title: "公考备考工作台",
    backgroundColor: "#f4f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.loadFile(path.join(__dirname, "gongkao-platform.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// IPC: 前端手动触发抓取时政文章
ipcMain.handle("refresh-articles", async () => {
  console.log("[IPC] 收到前端请求：手动更新时政文章");
  const result = await autoUpdateArticles(true);
  return result;
});

app.whenReady().then(async () => {
  // 启动时自动检查并更新文章
  console.log("[启动] 检查文章数据是否需要更新...");
  const updated = await autoUpdateArticles();
  
  createWindow();
  
  // 如果更新了文章，延迟刷新页面以加载新数据
  if (updated.updated && mainWindow) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload();
      }
    }, 1500);
  }
  
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
