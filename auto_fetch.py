#!/usr/bin/env python3
"""
auto_fetch_articles.py — 自动抓取前一天时政文章并更新 daily_articles.js
纯Python实现，不依赖AI，不消耗积分。
通过系统cron/Windows任务计划每天定时运行。

用法: python3 auto_fetch_articles.py
"""

import urllib.request
import urllib.error
import gzip
import io
import re
import os
import json
from datetime import datetime, timedelta

# ============ 配置 ============
WORK_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(WORK_DIR, "daily_articles.js")
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = 20

# 人民网基础URL
PEOPLE_BASE = "http://opinion.people.com.cn"

# ============ 工具函数 ============

def fetch_url(url):
    """获取URL内容，自动处理gzip编码"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read()
            # 检查是否gzip压缩
            if resp.headers.get('Content-Encoding') == 'gzip' or data[:2] == b'\x1f\x8b':
                try:
                    data = gzip.decompress(data)
                except:
                    pass
            # 尝试多种编码
            for enc in ['utf-8', 'gb2312', 'gbk', 'gb18030']:
                try:
                    return data.decode(enc)
                except:
                    continue
            return data.decode('utf-8', errors='replace')
    except Exception as e:
        print(f"  [警告] 获取失败 {url}: {e}")
        return None

def strip_html(text):
    """去除HTML标签"""
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<p[^>]*>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'</p>', '', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&')
    text = text.replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&quot;', '"').replace('&#39;', "'")
    text = text.replace('&ldquo;', '\u201c').replace('&rdquo;', '\u201d')
    text = text.replace('&mdash;', '\u2014').replace('&ndash;', '\u2013')
    text = text.replace('&hellip;', '\u2026')
    text = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()

def extract_title(html):
    """提取文章标题"""
    # 尝试 h1 标签
    m = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.DOTALL | re.IGNORECASE)
    if m:
        title = strip_html(m.group(1)).strip()
        if title:
            return title
    # 尝试特定class的标题
    m = re.search(r'class="[^"]*articleTitle[^"]*"[^>]*>(.*?)</', html, re.DOTALL | re.IGNORECASE)
    if m:
        title = strip_html(m.group(1)).strip()
        if title:
            return title
    # 尝试 title 标签
    m = re.search(r'<title>(.*?)</title>', html, re.DOTALL | re.IGNORECASE)
    if m:
        t = strip_html(m.group(1)).strip()
        for sep in ['_', '--', '-', '|', '－']:
            if sep in t:
                parts = t.split(sep)
                if parts[0].strip():
                    return parts[0].strip()
        return t
    return ""

def extract_content(html):
    """提取文章正文"""
    # 方法1: 查找 rm_txt_zw (人民网特有)
    m = re.search(r'id="rm_txt_zw"[^>]*>(.*?)(?:<div class="edit|<div class="zdfy|<div id="rwb_zw_er|<!--)', html, re.DOTALL | re.IGNORECASE)
    if m:
        text = strip_html(m.group(1))
        if len(text) > 200:
            return text

    # 方法2: 查找各种内容class
    for cls in ['rm_txt_con', 'article-content', 'article_content', 'TRS_Editor', 'box_con', 'content']:
        pat = rf'<div[^>]*class="[^"]*{cls}[^"]*"[^>]*>(.*?)(?:</div>\s*<div class="(?!{cls})|</div>\s*<div id=)'
        m = re.search(pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            text = strip_html(m.group(1))
            if len(text) > 200:
                return text

    # 方法3: 收集所有p标签内容
    paras = re.findall(r'<p[^>]*>(.*?)</p>', html, re.DOTALL | re.IGNORECASE)
    clean_paras = []
    for p in paras:
        text = strip_html(p).strip()
        if len(text) > 20:
            clean_paras.append(text)
    if clean_paras:
        result = '\n\n'.join(clean_paras)
        if len(result) > 200:
            return result

    return ""

def extract_summary(content, max_len=250):
    """从正文提取摘要"""
    if not content:
        return ""
    paras = [p.strip() for p in content.split('\n\n') if p.strip()]
    summary = ""
    for p in paras:
        if len(summary) + len(p) <= max_len:
            summary += p
        else:
            remaining = max_len - len(summary)
            if remaining > 30:
                summary += p[:remaining] + "..."
            break
    if not summary and content:
        summary = content[:max_len] + "..."
    return summary

def extract_date_from_url(url):
    """从URL提取日期"""
    # 匹配 /2026/0825/ 格式
    m = re.search(r'/(\d{4})/(\d{4})/', url)
    if m:
        year = m.group(1)
        md = m.group(2)
        return f"{year}-{md[:2]}-{md[2:]}"
    # 匹配 /2026-08/25/ 格式
    m = re.search(r'/(\d{4})-(\d{2})/(\d{2})/', url)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # 匹配 /20260825/ 格式
    m = re.search(r'/(\d{4})(\d{2})(\d{2})/', url)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return ""

def extract_tags(title, content):
    """简单提取标签"""
    tag_keywords = {
        "经济": ["经济", "GDP", "消费", "投资", "产业", "市场", "贸易", "金融"],
        "科技": ["科技", "人工智能", "AI", "创新", "技术", "数字", "机器人", "芯片"],
        "民生": ["民生", "就业", "社保", "医疗", "教育", "养老", "住房", "食品安全"],
        "治理": ["治理", "基层", "法治", "监管", "执法", "行政", "反腐"],
        "生态": ["生态", "环保", "绿色", "低碳", "碳", "环境", "污染"],
        "文化": ["文化", "文明", "旅游", "影视", "艺术", "传承"],
        "国际": ["国际", "外交", "关税", "中美", "全球", "贸易战", "制裁"],
        "乡村振兴": ["乡村", "农业", "农村", "农民", "脱贫", "粮食"],
        "高质量发展": ["高质量", "新质生产力", "改革", "开放", "发展"],
        "安全": ["安全", "国防", "军事", "武警", "应急"],
    }
    tags = []
    text = title + " " + content[:500]
    for tag, keywords in tag_keywords.items():
        for kw in keywords:
            if kw in text:
                if tag not in tags:
                    tags.append(tag)
                break
    return tags[:3] if tags else ["时政"]

def find_article_links(list_html, target_date):
    """从人民网列表页找到目标日期的文章链接（支持相对URL）"""
    # 匹配相对URL: /n1/2026/0825/c436867-40785887.html
    pattern = r'/n1/\d{4}/\d{4}/c\d+-\d+\.html'
    raw_links = re.findall(pattern, list_html)
    
    result = []
    seen = set()
    for link in raw_links:
        if link in seen:
            continue
        seen.add(link)
        article_date = extract_date_from_url(link)
        if article_date == target_date:
            full_url = PEOPLE_BASE + link
            result.append(full_url)
    return result

def fetch_article(url, source_name, target_date):
    """抓取单篇文章"""
    html = fetch_url(url)
    if not html:
        return None
    title = extract_title(html)
    content = extract_content(html)
    if not title or len(content) < 100:
        return None
    summary = extract_summary(content)
    tags = extract_tags(title, content)
    return {
        "title": title,
        "source": source_name,
        "date": target_date,
        "url": url,
        "summary": summary,
        "content": content,
        "tags": tags,
    }

def generate_js(articles, today_date):
    """生成JS文件内容"""
    lines = []
    lines.append("/* daily_articles.js — 每日时政文章数据（自动抓取生成）")
    lines.append(f" * 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if articles:
        lines.append(f" * 文章日期: {articles[0]['date']}")
    lines.append(" */")
    lines.append("window.DAILY_ARTICLES = {")
    lines.append(f'  date: "{today_date}",')
    lines.append("  articles: [")
    
    for i, art in enumerate(articles):
        # 转义反引号和反斜杠
        title = art["title"].replace("`", "'").replace("\\", "")
        source = art["source"].replace("`", "'")
        date = art["date"]
        url = art["url"]
        summary = art["summary"].replace("`", "'").replace("\\", "")
        content = art["content"].replace("`", "'").replace("\\", "")
        content = content.replace("\n", "\\n")
        
        tags_str = ", ".join(f'"{t}"' for t in art["tags"])
        
        lines.append("    {")
        lines.append(f"      id: {i+1},")
        lines.append(f"      title: `{title}`,")
        lines.append(f"      source: `{source}`,")
        lines.append(f"      date: `{date}`,")
        lines.append(f"      url: `{url}`,")
        lines.append(f"      summary: `{summary}`,")
        lines.append(f"      content: `{content}`,")
        lines.append(f"      tags: [{tags_str}],")
        lines.append("      likes: 0")
        lines.append("    }" + ("," if i < len(articles) - 1 else ""))
    
    lines.append("  ]")
    lines.append("};")
    return "\n".join(lines)

# ============ 主逻辑 ============

def get_yesterday_date():
    yesterday = datetime.now() - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d")

def get_today_date():
    return datetime.now().strftime("%Y-%m-%d")

def main():
    today = get_today_date()
    yesterday = get_yesterday_date()
    
    print(f"=== 自动抓取时政文章 ===")
    print(f"今天: {today}, 目标文章日期: {yesterday}")
    print()
    
    all_articles = []
    
    # 来源1: 人民网观点频道第1页
    print("[人民网观点] 获取文章列表...")
    list_html = fetch_url(f"{PEOPLE_BASE}/GB/159301/")
    if list_html:
        target_links = find_article_links(list_html, yesterday)
        print(f"  找到 {len(target_links)} 篇 {yesterday} 的文章")
        
        for link in target_links:
            if len(all_articles) >= 8:
                break
            print(f"  抓取: {link}")
            article = fetch_article(link, "人民网", yesterday)
            if article:
                all_articles.append(article)
                print(f"    -> {article['title'][:50]}...")
    else:
        print("  [失败] 无法获取列表页")
    
    # 来源2: 人民网观点频道第2页
    if len(all_articles) < 5:
        print(f"\n[人民网观点第2页] 获取文章列表...")
        list_html2 = fetch_url(f"{PEOPLE_BASE}/GB/159301/index2.html")
        if list_html2:
            target_links2 = find_article_links(list_html2, yesterday)
            print(f"  找到 {len(target_links2)} 篇 {yesterday} 的文章")
            
            for link in target_links2:
                if len(all_articles) >= 8:
                    break
                print(f"  抓取: {link}")
                article = fetch_article(link, "人民网", yesterday)
                if article:
                    all_articles.append(article)
                    print(f"    -> {article['title'][:50]}...")
    
    # 来源3: 人民网评论频道
    if len(all_articles) < 5:
        print(f"\n[人民网评论] 获取文章列表...")
        list_html3 = fetch_url(f"{PEOPLE_BASE}/GB/223228/")
        if list_html3:
            target_links3 = find_article_links(list_html3, yesterday)
            print(f"  找到 {len(target_links3)} 篇 {yesterday} 的文章")
            
            for link in target_links3:
                if len(all_articles) >= 8:
                    break
                print(f"  抓取: {link}")
                article = fetch_article(link, "人民网", yesterday)
                if article:
                    all_articles.append(article)
                    print(f"    -> {article['title'][:50]}...")
    
    # 来源4: 人民网国际观点频道
    if len(all_articles) < 3:
        print(f"\n[人民网国际] 获取文章列表...")
        list_html4 = fetch_url(f"{PEOPLE_BASE}/GB/462004/")
        if list_html4:
            target_links4 = find_article_links(list_html4, yesterday)
            print(f"  找到 {len(target_links4)} 篇 {yesterday} 的文章")
            
            for link in target_links4:
                if len(all_articles) >= 8:
                    break
                print(f"  抓取: {link}")
                article = fetch_article(link, "人民网", yesterday)
                if article:
                    all_articles.append(article)
                    print(f"    -> {article['title'][:50]}...")
    
    print(f"\n总共抓取 {len(all_articles)} 篇文章")
    
    if len(all_articles) < 1:
        print("[警告] 未抓取到任何文章，不更新文件，保留旧数据")
        return
    
    js_content = generate_js(all_articles, today)
    
    # 备份旧文件
    if os.path.exists(OUTPUT_FILE):
        backup = OUTPUT_FILE + ".bak"
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                old_content = f.read()
            with open(backup, "w", encoding="utf-8") as f:
                f.write(old_content)
            print(f"已备份旧文件到 {backup}")
        except:
            pass
    
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(js_content)
    print(f"已更新 {OUTPUT_FILE}")
    print(f"文章日期: {yesterday}, 数据日期: {today}")
    print("=== 完成 ===")

if __name__ == "__main__":
    main()
