const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdEditor', {
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  saveFileDialog: (defaultPath, content) =>
    ipcRenderer.invoke('dialog:save-file', { defaultPath, content }),
  readText: (filePath) => ipcRenderer.invoke('fs:read-text', filePath),
  writeText: (filePath, content) =>
    ipcRenderer.invoke('fs:write-text', { path: filePath, content }),
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  openPath: (target) => ipcRenderer.invoke('fs:open-path', target),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  resolveUrl: (baseDir, target) =>
    ipcRenderer.sendSync('fs:resolve-url', { baseDir, target }),
  resolvePath: (baseDir, target) =>
    ipcRenderer.sendSync('fs:resolve-path', { baseDir, target }),
  setDirty: (dirty) => ipcRenderer.send('window:set-dirty', dirty),
  report: (payload) => ipcRenderer.send('app:report', payload),
  onMenuAction: (callback) => {
    ipcRenderer.on('menu-action', (_event, action) => callback(action));
  },
  onFileOpen: (callback) => {
    ipcRenderer.on('file-open', (_event, filePath) => callback(filePath));
  },
});
