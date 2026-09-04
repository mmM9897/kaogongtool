#!/bin/bash
# 公考备考工作台 - 每日时政文章更新启动脚本
# 双击运行即可打开工作台并检查文章更新

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  公考备考工作台 - 每日时政文章更新"
echo "============================================"
echo ""
echo "文章数据文件: $DIR/daily_articles.js"
echo "自动更新任务: 每天早上7:00自动执行"
echo ""

# 尝试用默认浏览器打开
if command -v xdg-open &> /dev/null; then
    xdg-open "$DIR/gongkao-platform.html" &
    echo "浏览器已打开工作台。"
elif command -v open &> /dev/null; then
    open "$DIR/gongkao-platform.html" &
    echo "浏览器已打开工作台。"
else
    echo "请手动打开: $DIR/gongkao-platform.html"
fi

echo ""
echo "如需手动更新文章，请在工作台中点击"
echo "\"时政积累\"模块的刷新按钮。"
echo ""
read -p "按回车键退出..."
