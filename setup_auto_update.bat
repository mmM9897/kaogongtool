@echo off
chcp 65001 >nul 2>&1
REM ============================================
REM setup_auto_update.bat — 一键设置Windows定时任务
REM 双击运行即可，会创建每天早上8点自动更新的计划任务
REM ============================================

echo.
echo ============================================
echo   公考时政平台 - 自动更新定时任务设置
echo ============================================
echo.

REM 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"
set "BAT_PATH=%SCRIPT_DIR%daily_update.bat"

REM 检查daily_update.bat是否存在
if not exist "%BAT_PATH%" (
    echo [错误] 找不到 daily_update.bat
    echo 请确保此文件与 daily_update.bat 在同一目录下
    pause
    exit /b 1
)

echo 即将创建Windows定时任务:
echo   任务名称: GongkaoDailyUpdate
echo   运行时间: 每天 早上 8:00
echo   运行文件: %BAT_PATH%
echo.

REM 需要管理员权限来创建任务
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 需要管理员权限，正在请求...
    powershell -Command "Start-Process cmd -ArgumentList '/c %~f0' -Verb RunAs"
    exit /b
)

REM 删除旧任务（如果存在）
schtasks /delete /tn "GongkaoDailyUpdate" /f >nul 2>&1

REM 创建新任务：每天早上8点运行
schtasks /create /tn "GongkaoDailyUpdate" /tr "%BAT_PATH%" /sc daily /st 08:00 /rl highest /f

if %errorlevel% == 0 (
    echo.
    echo [成功] 定时任务已创建！
    echo   每天早上 8:00 会自动抓取前一天的时政文章
    echo   并更新 daily_articles.js 文件
    echo.
    echo   如需手动测试，双击 daily_update.bat 即可
    echo   查看运行日志: update_log.txt
    echo.
    echo   如需删除定时任务，运行:
    echo   schtasks /delete /tn "GongkaoDailyUpdate" /f
) else (
    echo.
    echo [失败] 创建定时任务失败，请手动设置:
    echo   1. 打开"任务计划程序"
    echo   2. 创建基本任务，名称: GongkaoDailyUpdate
    echo   3. 触发器: 每天，08:00
    echo   4. 操作: 启动程序，选择 %BAT_PATH%
)

echo.
pause
