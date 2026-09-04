const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('joaDesktop', {
  isDesktop: true,
  getWorkingFolder: () => ipcRenderer.invoke('desktop:getWorkingFolder'),
  setWorkingFolder: (folderPath) => ipcRenderer.invoke('desktop:setWorkingFolder', folderPath),
  clearWorkingFolder: () => ipcRenderer.invoke('desktop:clearWorkingFolder'),
  pickFolder: (options) => ipcRenderer.invoke('desktop:pickFolder', options || {}),
  pickOpenFiles: (options) => ipcRenderer.invoke('desktop:pickOpenFiles', options || {}),
  pickSaveFile: (options) => ipcRenderer.invoke('desktop:pickSaveFile', options || {}),
  writeFile: (filePath, data) => ipcRenderer.invoke('desktop:writeFile', filePath, data),
  writeFileBegin: (filePath) => ipcRenderer.invoke('desktop:writeFileBegin', filePath),
  writeFileChunk: (filePath, data) => ipcRenderer.invoke('desktop:writeFileChunk', filePath, data),
  writeFileEnd: (filePath) => ipcRenderer.invoke('desktop:writeFileEnd', filePath),
  writeFilesToFolder: (folderPath, files) =>
    ipcRenderer.invoke('desktop:writeFilesToFolder', folderPath, files),
  revealInFolder: (targetPath) => ipcRenderer.invoke('desktop:revealInFolder', targetPath),
  copyImagesToClipboard: (files) => ipcRenderer.invoke('desktop:copyImagesToClipboard', files),
});
