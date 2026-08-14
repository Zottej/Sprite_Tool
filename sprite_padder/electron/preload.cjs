const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('joaDesktop', {
  isDesktop: true,
  getWorkingFolder: () => ipcRenderer.invoke('desktop:getWorkingFolder'),
  setWorkingFolder: (folderPath) => ipcRenderer.invoke('desktop:setWorkingFolder', folderPath),
  clearWorkingFolder: () => ipcRenderer.invoke('desktop:clearWorkingFolder'),
  pickFolder: () => ipcRenderer.invoke('desktop:pickFolder'),
  pickOpenFiles: (options) => ipcRenderer.invoke('desktop:pickOpenFiles', options || {}),
  pickSaveFile: (options) => ipcRenderer.invoke('desktop:pickSaveFile', options || {}),
  writeFile: (filePath, data) => ipcRenderer.invoke('desktop:writeFile', filePath, data),
  writeFilesToFolder: (folderPath, files) =>
    ipcRenderer.invoke('desktop:writeFilesToFolder', folderPath, files),
  revealInFolder: (targetPath) => ipcRenderer.invoke('desktop:revealInFolder', targetPath),
});
