@echo off
chcp 65001 >nul
title 公考平台 - 每日时政文章更新
echo ============================================
echo   公考备考工作台 - 每日时政文章更新
echo ============================================
echo.
echo 正在启动公考备考工作台...
echo.
echo 文章数据文件: daily_articles.js
echo 自动更新任务: 每天早上7:00自动执行
echo.
start "" "%~dp0gongkao-platform.html"
echo 浏览器已打开工作台。
echo.
echo 如需手动更新文章，请在工作台中点击
echo "时政积累"模块的刷新按钮。
echo.
pause
