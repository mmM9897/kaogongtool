# 公考备考工作台桌面 APP

本目录已包含 Electron 桌面包装文件，可将 `gongkao-platform.html` 作为本地桌面应用运行。

## 文件说明

- `gongkao-platform.html`：主应用，纯前端、无 CDN、数据写入浏览器 localStorage。
- `daily_articles.js`：每日时政示例文章数据。
- `package.json`：Electron 项目配置和启动命令。
- `main.js`：Electron 主进程入口，加载本地 HTML。

## 运行方式

请先安装 Node.js，然后在本目录执行：

```bash
npm install
npm start
```

## 打包成桌面 APP

已在 `package.json` 中加入 Electron Builder 配置。安装依赖后，可以执行：

```bash
npm run build
```

打包完成后，成品会出现在：

```text
dist/
```

如果只打包当前系统对应版本，直接使用 `npm run build` 即可。也可以按目标系统分别执行：

```bash
npm run build:linux
npm run build:win
npm run build:mac
```

说明：跨系统打包可能需要对应平台环境支持。例如在 Windows 上打包 Windows 安装包最稳，在 macOS 上打包 macOS 应用最稳。

## 浏览器运行

也可以直接用浏览器打开：

```text
gongkao-platform.html
```

## 数据说明

学习任务、打卡、笔记、知识树、阅读状态、主题和考试日期均保存在本机 `localStorage` 中，存储 key 为：

```text
gongkao-platform-v1
```

## 时政文章规则

- `daily_articles.js` 至少保留 10 篇文章。
- 当前文章卡片上会显示“阅读原文”按钮，可直接跳转到文章出处。
- 每日文章数据更新后，旧文章默认不再显示。
- 旧文章中已收藏的内容会保留在“历史收藏”区域，排在当前文章后面。
- 历史收藏只显示标题和“阅读原文”按钮，避免旧内容占用太多页面空间。
