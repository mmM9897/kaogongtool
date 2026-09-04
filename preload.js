const { contextBridge, ipcRenderer } = require("electron");

// 通过 contextBridge 安全暴露 IPC 接口给渲染进程
contextBridge.exposeInMainWorld("electronAPI", {
  // 触发时政文章抓取更新
  refreshArticles: () => ipcRenderer.invoke("refresh-articles"),
  // 检查是否在 Electron 环境中
  isElectron: true,
});
