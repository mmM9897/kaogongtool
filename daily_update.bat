@echo off
chcp 65001 >nul 2>&1
REM ============================================
REM daily_update.bat — 每日自动抓取时政文章
REM 此文件由Windows任务计划程序每天自动调用
REM 也可双击手动运行
REM ============================================

REM 切换到脚本所在目录
cd /d "%~dp0"

REM 记录运行日志
echo =============================================== >> update_log.txt
echo [%date% %time%] 开始自动更新 >> update_log.txt

REM 尝试用Node.js运行（推荐，因为Electron已自带Node）
where node >nul 2>&1
if %errorlevel% == 0 (
    echo [%date% %time%] 使用Node.js运行 >> update_log.txt
    node auto_fetch.js >> update_log.txt 2>&1
    goto :done
)

REM 如果没有Node.js，尝试用Python
where python >nul 2>&1
if %errorlevel% == 0 (
    echo [%date% %time%] 使用Python运行 >> update_log.txt
    python auto_fetch.py >> update_log.txt 2>&1
    goto :done
)

where python3 >nul 2>&1
if %errorlevel% == 0 (
    echo [%date% %time%] 使用Python3运行 >> update_log.txt
    python3 auto_fetch.py >> update_log.txt 2>&1
    goto :done
)

echo [%date% %time%] 错误: 未找到Node.js或Python，请安装其中之一 >> update_log.txt

:done
echo [%date% %time%] 更新完成 >> update_log.txt
echo =============================================== >> update_log.txt
