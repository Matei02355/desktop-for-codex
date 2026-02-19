const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesktop", {
  loadState: () => ipcRenderer.invoke("app:load-state"),
  saveState: (state) => ipcRenderer.invoke("app:save-state", state),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),
  pickImages: () => ipcRenderer.invoke("dialog:pick-images"),
  listFolder: (folderPath) => ipcRenderer.invoke("fs:list-folder", folderPath),
  readWorkspaceFile: (payload) => ipcRenderer.invoke("fs:read-workspace-file", payload),
  listWorkspaceChanges: (folderPath) => ipcRenderer.invoke("git:workspace-changes", folderPath),
  getCodexStatus: (payload) => ipcRenderer.invoke("codex:status", payload),
  sendPrompt: (payload) => ipcRenderer.invoke("codex:send", payload),
  cancelPrompt: (requestId) => ipcRenderer.invoke("codex:cancel", requestId),
  savePastedImage: (dataUrl) => ipcRenderer.invoke("clipboard:save-image", dataUrl)
});
