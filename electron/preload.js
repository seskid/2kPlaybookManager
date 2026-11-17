// Exposes a small, fixed API to the page. The page never gets Node or Electron directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('porter', {
  isDesktop: true,
  pickXboxFolder: () => ipcRenderer.invoke('pick-xbox-folder'),
  saveFile: (fileName, bytes) => ipcRenderer.invoke('save-file', fileName, bytes),
  saveFilesToFolder: files => ipcRenderer.invoke('save-files-to-folder', files),
  saveXboxFolder: (folderName, files) => ipcRenderer.invoke('save-xbox-folder', folderName, files),
  showInFolder: target => ipcRenderer.invoke('show-in-folder', target),
});
