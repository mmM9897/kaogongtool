#!/usr/bin/env node
/**
 * auto_fetch.js — 自动抓取前一天时政文章并更新 daily_articles.js
 * 纯Node.js实现，不依赖AI，不消耗积分。
 * 通过Windows任务计划/cron每天定时运行。
 *
 * 用法: node auto_fetch.js
 * 
 * 放置在 gongkao-platform.html 同目录下运行即可自动更新 daily_articles.js
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const OUTPUT_FILE = path.join(__dirname, 'daily_articles.js');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 20000;
const PEOPLE_BASE = 'http://opinion.people.com.cn';

// ============ 工具函数 ============

function getProxy() {
    // 检查代理环境变量（沙箱环境可能需要，用户电脑通常不需要）
    const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) {
        const m = proxy.match(/^(https?):\/\/([^:]+):(\d+)/);
        if (m) return { host: m[2], port: parseInt(m[3]) };
    }
    return null;
}

const PROXY = getProxy();

function fetchUrl(url) {
    return new Promise((resolve) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        
        let options;
        if (PROXY && !isHttps) {
            // HTTP通过代理：连接代理服务器，请求完整URL
            options = {
                host: PROXY.host,
                port: PROXY.port,
                path: url,
                method: 'GET',
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Accept-Encoding': 'gzip, deflate',
                    'Host': parsed.host,
                },
                timeout: TIMEOUT,
            };
        } else if (PROXY && isHttps) {
            // HTTPS通过代理：使用CONNECT隧道
            options = {
                host: PROXY.host,
                port: PROXY.port,
                path: url,
                method: 'GET',
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Accept-Encoding': 'gzip, deflate',
                    'Host': parsed.host,
                },
                timeout: TIMEOUT,
            };
        } else {
            // 直连
            options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Accept-Encoding': 'gzip, deflate',
                },
                timeout: TIMEOUT,
            };
        }
        
        const req = mod.request(options, (resp) => {
            const chunks = [];
            resp.on('data', (chunk) => chunks.push(chunk));
            resp.on('end', () => {
                let data = Buffer.concat(chunks);
                // 处理gzip
                const encoding = resp.headers['content-encoding'];
                try {
                    if (encoding === 'gzip' || (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)) {
                        data = zlib.gunzipSync(data);
                    } else if (encoding === 'deflate') {
                        data = zlib.inflateSync(data);
                    }
                } catch (e) { /* 忽略解压错误 */ }
                
                const dataStr = data.toString('utf-8');
                resolve(dataStr);
            });
        });
        req.on('error', (e) => {
            console.log(`  [警告] 获取失败 ${url}: ${e.message}`);
            resolve(null);
        });
        req.on('timeout', () => {
            req.destroy();
            console.log(`  [警告] 超时 ${url}`);
            resolve(null);
        });
        req.end();
    });
}

function stripHtml(text) {
    text = text.replace(/<script[^>]*>.*?<\/script>/gis, '');
    text = text.replace(/<style[^>]*>.*?<\/style>/gis, '');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<p[^>]*>/gi, '\n');
    text = text.replace(/<\/p>/gi, '');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/&ldquo;/g, '\u201c').replace(/&rdquo;/g, '\u201d');
    text = text.replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013');
    text = text.replace(/&hellip;/g, '\u2026');
    text = text.replace(/&#(\d+);/g, (m, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/[ \t]+/g, ' ');
    return text.trim();
}

function extractTitle(html) {
    let m = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
    if (m) {
        const title = stripHtml(m[1]).trim();
        if (title) return title;
    }
    m = html.match(/class="[^"]*articleTitle[^"]*"[^>]*>(.*?)</is);
    if (m) {
        const title = stripHtml(m[1]).trim();
        if (title) return title;
    }
    m = html.match(/<title>(.*?)<\/title>/is);
    if (m) {
        let t = stripHtml(m[1]).trim();
        for (const sep of ['_', '--', '-', '|', '－']) {
            if (t.includes(sep)) {
                const parts = t.split(sep);
                if (parts[0].trim()) return parts[0].trim();
            }
        }
        return t;
    }
    return '';
}

function extractContent(html) {
    // 方法1: rm_txt_zw (人民网)
    let m = html.match(/id="rm_txt_zw"[^>]*>(.*?)(?:<div class="edit|<div class="zdfy|<div id="rwb_zw_er|<!--)/is);
    if (m) {
        const text = stripHtml(m[1]);
        if (text.length > 200) return text;
    }
    // 方法2: 各种内容class
    for (const cls of ['rm_txt_con', 'article-content', 'article_content', 'TRS_Editor', 'box_con', 'content']) {
        const pat = new RegExp(`<div[^>]*class="[^"]*${cls}[^"]*"[^>]*>(.*?)(?:</div>\\s*<div class="(?!${cls})|</div>\\s*<div id=)`, 'is');
        m = html.match(pat);
        if (m) {
            const text = stripHtml(m[1]);
            if (text.length > 200) return text;
        }
    }
    // 方法3: 收集p标签
    const paras = [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)];
    const cleanParas = [];
    for (const p of paras) {
        const text = stripHtml(p[1]).trim();
        if (text.length > 20) cleanParas.push(text);
    }
    if (cleanParas.length > 0) {
        const result = cleanParas.join('\n\n');
        if (result.length > 200) return result;
    }
    return '';
}

function extractSummary(content, maxLen = 250) {
    if (!content) return '';
    const paras = content.split('\n\n').filter(p => p.trim());
    let summary = '';
    for (const p of paras) {
        if (summary.length + p.length <= maxLen) {
            summary += p;
        } else {
            const remaining = maxLen - summary.length;
            if (remaining > 30) summary += p.substring(0, remaining) + '...';
            break;
        }
    }
    if (!summary && content) summary = content.substring(0, maxLen) + '...';
    return summary;
}

function extractDateFromUrl(url) {
    let m = url.match(/\/(\d{4})\/(\d{4})\//);
    if (m) return `${m[1]}-${m[2].substring(0,2)}-${m[2].substring(2)}`;
    m = url.match(/\/(\d{4})-(\d{2})\/(\d{2})\//);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return '';
}

function extractTags(title, content) {
    const tagKeywords = {
        '经济': ['经济', 'GDP', '消费', '投资', '产业', '市场', '贸易', '金融'],
        '科技': ['科技', '人工智能', 'AI', '创新', '技术', '数字', '机器人', '芯片'],
        '民生': ['民生', '就业', '社保', '医疗', '教育', '养老', '住房', '食品安全'],
        '治理': ['治理', '基层', '法治', '监管', '执法', '行政', '反腐'],
        '生态': ['生态', '环保', '绿色', '低碳', '碳', '环境', '污染'],
        '文化': ['文化', '文明', '旅游', '影视', '艺术', '传承'],
        '国际': ['国际', '外交', '关税', '中美', '全球', '贸易战', '制裁'],
        '乡村振兴': ['乡村', '农业', '农村', '农民', '脱贫', '粮食'],
        '高质量发展': ['高质量', '新质生产力', '改革', '开放', '发展'],
        '安全': ['安全', '国防', '军事', '武警', '应急'],
    };
    const tags = [];
    const text = title + ' ' + content.substring(0, 500);
    for (const [tag, keywords] of Object.entries(tagKeywords)) {
        for (const kw of keywords) {
            if (text.includes(kw)) {
                if (!tags.includes(tag)) tags.push(tag);
                break;
            }
        }
    }
    return tags.length > 0 ? tags.slice(0, 3) : ['时政'];
}

function findArticleLinks(listHtml, targetDate) {
    const pattern = /\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html/g;
    const rawLinks = [...listHtml.matchAll(pattern)].map(m => m[0]);
    const result = [];
    const seen = new Set();
    for (const link of rawLinks) {
        if (seen.has(link)) continue;
        seen.add(link);
        const articleDate = extractDateFromUrl(link);
        if (articleDate === targetDate) {
            result.push(PEOPLE_BASE + link);
        }
    }
    return result;
}

async function fetchArticle(url, sourceName, targetDate) {
    const html = await fetchUrl(url);
    if (!html) return null;
    const title = extractTitle(html);
    const content = extractContent(html);
    if (!title || content.length < 100) return null;
    const summary = extractSummary(content);
    const tags = extractTags(title, content);
    return { title, source: sourceName, date: targetDate, url, summary, content, tags };
}

// ============ 半月谈文章解析 ============
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

function extractBanyuetanSource(html) {
    const m = html.match(/<div[^>]*class="[^"]*detail_tit_source[^"]*"[^>]*>(.*?)<\/div>/is);
    if (m) { const t = stripHtml(m[1]).trim(); if (t) return t; }
    return "半月谈";
}

async function fetchBanyuetanArticle(url, targetDate) {
    if (fetchedUrls.has(url)) return null;
    fetchedUrls.add(url);
    const html = await fetchUrl(url);
    if (!html) return null;
    const title = extractBanyuetanTitle(html);
    const content = extractBanyuetanContent(html);
    if (!title || content.length < 100) return null;
    const bizKeywords = ["半年报", "年报", "财报", "净利润", "营业收入", "股票代码", "毛利率", "市值", "营收", "同比增"];
    if (bizKeywords.some(k => title.includes(k) || content.substring(0, 300).includes(k))) return null;
    let source = extractBanyuetanSource(html);
    source = source.replace(/^来源：/, "").trim();
    if (!source || source.length > 20) source = "半月谈";
    return { title, source, date: targetDate, url, summary: extractSummary(content), content, tags: extractTags(title, content) };
}

function findBanyuetanLinks(listHtml, targetDateCompact) {
    const pattern = new RegExp("href=\"(https?://www\\.banyuetan\\.org/[^\"]*" + targetDateCompact + "[^\"]*\\.html)\"", "g");
    const links = [...listHtml.matchAll(pattern)].map(m => m[1]);
    return [...new Set(links)];
}

function generateJs(articles, todayDate) {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    
    const lines = [];
    lines.push('/* daily_articles.js — 每日时政文章数据（自动抓取生成）');
    lines.push(` * 生成时间: ${ts}`);
    if (articles.length > 0) lines.push(` * 文章日期: ${articles[0].date}`);
    lines.push(' */');
    lines.push('window.DAILY_ARTICLES = {');
    lines.push(`  date: "${todayDate}",`);
    lines.push('  articles: [');
    
    for (let i = 0; i < articles.length; i++) {
        const art = articles[i];
        const title = art.title.replace(/`/g, "'").replace(/\\/g, '');
        const source = art.source.replace(/`/g, "'");
        const summary = art.summary.replace(/`/g, "'").replace(/\\/g, '');
        let content = art.content.replace(/`/g, "'").replace(/\\/g, '');
        content = content.replace(/\n/g, '\\n');
        const tagsStr = art.tags.map(t => `"${t}"`).join(', ');
        
        lines.push('    {');
        lines.push(`      id: ${i+1},`);
        lines.push(`      title: \`${title}\`,`);
        lines.push(`      source: \`${source}\`,`);
        lines.push(`      date: \`${art.date}\`,`);
        lines.push(`      url: \`${art.url}\`,`);
        lines.push(`      summary: \`${summary}\`,`);
        lines.push(`      content: \`${content}\`,`);
        lines.push(`      tags: [${tagsStr}],`);
        lines.push('      likes: 0');
        lines.push('    }' + (i < articles.length - 1 ? ',' : ''));
    }
    
    lines.push('  ]');
    lines.push('};');
    return lines.join('\n');
}

// ============ 主逻辑 ============

async function main() {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
    
    console.log('=== 自动抓取时政文章 ===');
    console.log(`今天: ${today}, 目标文章日期: ${yesterdayStr}`);
    console.log();
    
    const allArticles = [];
    const fetchedUrls = new Set(); // 全局去重
    
    async function fetchArticleUnique(url, source, date) {
        if (fetchedUrls.has(url)) return null;
        fetchedUrls.add(url);
        return await fetchArticle(url, source, date);
    }
    
    async function fetchFromPage(pageUrl, sourceName, targetDate, maxCount) {
        console.log(`[${sourceName}] 获取文章列表...`);
        const html = await fetchUrl(pageUrl);
        if (!html) { console.log('  [失败] 无法获取列表页'); return; }
        const links = findArticleLinks(html, targetDate);
        console.log(`  找到 ${links.length} 篇 ${targetDate} 的文章`);
        for (const link of links) {
            if (allArticles.length >= maxCount) break;
            const article = await fetchArticleUnique(link, sourceName, targetDate);
            if (article) { allArticles.push(article); console.log(`    -> ${article.title.substring(0, 50)}...`); }
        }
    }
    
    async function fetchFromCustomPage(pageUrl, baseUrl, sourceName, targetDate, maxCount) {
        console.log(`[${sourceName}] 获取文章列表...`);
        const html = await fetchUrl(pageUrl);
        if (!html) { console.log('  [失败] 无法获取列表页'); return; }
        const raw = [...new Set([...html.matchAll(/\/n1\/\d{4}\/\d{4}\/c\d+-\d+\.html/g)].map(m => m[0]))];
        const links = raw.filter(l => extractDateFromUrl(l) === targetDate).map(l => baseUrl + l);
        console.log(`  找到 ${links.length} 篇 ${targetDate} 的文章`);
        for (const link of links) {
            if (allArticles.length >= maxCount) break;
            const article = await fetchArticleUnique(link, sourceName, targetDate);
            if (article) { allArticles.push(article); console.log(`    -> ${article.title.substring(0, 50)}...`); }
        }
    }
    
    const TARGET = 15;
    
    // 来源1: 人民网观点频道
    await fetchFromPage(`${PEOPLE_BASE}/GB/159301/`, '人民网观点', yesterdayStr, TARGET);
    
    // 来源2: 观点频道第2页
    if (allArticles.length < 10) await fetchFromPage(`${PEOPLE_BASE}/GB/159301/index2.html`, '人民网观点2', yesterdayStr, TARGET);
    
    // 来源3: 人民日报观点频道
    if (allArticles.length < 10) await fetchFromPage(`${PEOPLE_BASE}/GB/223228/`, '人民日报观点', yesterdayStr, TARGET);
    
    // 来源4: 环球网评
    if (allArticles.length < 10) await fetchFromPage(`${PEOPLE_BASE}/GB/462004/`, '环球网评', yesterdayStr, TARGET);
    
    // 来源5: 人民网评
    if (allArticles.length < 10) await fetchFromPage(`${PEOPLE_BASE}/GB/436867/`, '人民网评', yesterdayStr, TARGET);
    
    // 来源6: 半月谈首页（公考核心来源）
    if (allArticles.length < 15) {
        const yDateCompact = yesterdayStr.replace(/-/g, "");
        await (async () => {
            console.log('\n[半月谈首页] 获取文章列表...');
            const btHtml = await fetchUrl('http://www.banyuetan.org/');
            if (!btHtml) { console.log('  [失败] 无法获取列表页'); return; }
            const btLinks = findBanyuetanLinks(btHtml, yDateCompact);
            console.log(`  找到 ${btLinks.length} 篇 ${yesterdayStr} 的文章`);
            for (const link of btLinks) {
                if (allArticles.length >= TARGET) break;
                if (link.includes("/ppzx/")) continue;
                const article = await fetchBanyuetanArticle(link, yesterdayStr);
                if (article) { allArticles.push(article); console.log(`    -> ${article.title.substring(0, 50)}...`); }
            }
        })();
    }
    
    // 来源7: 半月谈今日谈板块
    if (allArticles.length < 15) {
        const yDateCompact = yesterdayStr.replace(/-/g, "");
        await (async () => {
            console.log('\n[半月谈今日谈] 获取文章列表...');
            const btHtml = await fetchUrl('http://www.banyuetan.org/jrt/');
            if (!btHtml) { console.log('  [失败] 无法获取列表页'); return; }
            const btLinks = findBanyuetanLinks(btHtml, yDateCompact);
            console.log(`  找到 ${btLinks.length} 篇 ${yesterdayStr} 的文章`);
            for (const link of btLinks) {
                if (allArticles.length >= TARGET) break;
                const article = await fetchBanyuetanArticle(link, yesterdayStr);
                if (article) { allArticles.push(article); console.log(`    -> ${article.title.substring(0, 50)}...`); }
            }
        })();
    }
    
    console.log(`\n总共抓取 ${allArticles.length} 篇文章`);
    
    if (allArticles.length < 1) {
        console.log('[警告] 未抓取到任何文章，不更新文件，保留旧数据');
        return;
    }
    
    const jsContent = generateJs(allArticles, today);
    
    // 备份旧文件
    if (fs.existsSync(OUTPUT_FILE)) {
        const backup = OUTPUT_FILE + '.bak';
        try {
            fs.copyFileSync(OUTPUT_FILE, backup);
            console.log(`已备份旧文件到 ${backup}`);
        } catch (e) { /* 忽略 */ }
    }
    
    fs.writeFileSync(OUTPUT_FILE, jsContent, 'utf-8');
    console.log(`已更新 ${OUTPUT_FILE}`);
    console.log(`文章日期: ${yesterdayStr}, 数据日期: ${today}`);
    console.log('=== 完成 ===');
}

main().catch(err => {
    console.error('运行出错:', err);
    process.exit(1);
});
