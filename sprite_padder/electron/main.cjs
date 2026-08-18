const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONFIG_NAME = 'joa-desktop-config.json';

const configPath = () => path.join(app.getPath('userData'), CONFIG_NAME);

const readConfig = () => {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const writeConfig = (patch) => {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
};

const getWorkingFolder = () => {
  const folder = readConfig().workingFolder;
  if (!folder || typeof folder !== 'string') return null;
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return null;
  return { path: folder, name: path.basename(folder) };
};

const resolveAppHtml = () => {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'index.html'),
    path.join(__dirname, '..', '..', 'JOA_Sprite_Padder.html'),
    path.join('C:\\JOA', 'JOA_Sprite_Padder.html'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

let mainWindow = null;

const createWindow = () => {
  const htmlPath = resolveAppHtml();
  if (!htmlPath) {
    dialog.showErrorBox(
      'JOA Sprite Padder',
      'No se encontró dist/index.html ni JOA_Sprite_Padder.html.\nEjecutá npm run build primero.'
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#050507',
    title: 'JOA Sprite Padder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(htmlPath);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('desktop:getWorkingFolder', async () => getWorkingFolder());

ipcMain.handle('desktop:setWorkingFolder', async (_event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') {
    writeConfig({ workingFolder: null });
    return null;
  }
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`La carpeta no existe: ${folderPath}`);
  }
  writeConfig({ workingFolder: folderPath });
  return { path: folderPath, name: path.basename(folderPath) };
});

ipcMain.handle('desktop:clearWorkingFolder', async () => {
  writeConfig({ workingFolder: null });
  return null;
});

ipcMain.handle('desktop:pickFolder', async () => {
  const current = getWorkingFolder();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Elegir carpeta de trabajo',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current?.path,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folderPath = result.filePaths[0];
  writeConfig({ workingFolder: folderPath });
  return { path: folderPath, name: path.basename(folderPath) };
});

ipcMain.handle('desktop:pickOpenFiles', async (_event, options = {}) => {
  const current = getWorkingFolder();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Abrir imágenes',
    properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    defaultPath: current?.path,
    filters: options.filters || [
      { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  const files = [];
  for (const filePath of result.filePaths) {
    const buffer = await fsp.readFile(filePath);
    files.push({
      name: path.basename(filePath),
      path: filePath,
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });
  }

  // Record parent folder of first file as working folder for future dialogs.
  const parent = path.dirname(result.filePaths[0]);
  if (fs.existsSync(parent)) writeConfig({ workingFolder: parent });

  return files;
});

ipcMain.handle('desktop:pickSaveFile', async (_event, options = {}) => {
  const current = getWorkingFolder();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Guardar archivo',
    defaultPath: path.join(current?.path || app.getPath('documents'), options.suggestedName || 'export.bin'),
    filters: options.filters || [{ name: 'Todos', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;

  const parent = path.dirname(result.filePath);
  if (fs.existsSync(parent)) writeConfig({ workingFolder: parent });
  return result.filePath;
});

ipcMain.handle('desktop:writeFile', async (_event, filePath, data) => {
  if (!filePath) throw new Error('Ruta de archivo vacía.');
  const buffer = Buffer.from(data);
  if (buffer.byteLength === 0) throw new Error('No se puede escribir un archivo vacío.');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
  return true;
});

const desktopWriteStreams = new Map();

ipcMain.handle('desktop:writeFileBegin', async (_event, filePath) => {
  if (!filePath) throw new Error('Ruta de archivo vacía.');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath);
  desktopWriteStreams.set(filePath, stream);
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('open', () => resolve(true));
  });
});

ipcMain.handle('desktop:writeFileChunk', async (_event, filePath, data) => {
  const stream = desktopWriteStreams.get(filePath);
  if (!stream) throw new Error('No hay escritura activa para ese archivo.');
  const buffer = Buffer.from(data);
  if (buffer.byteLength === 0) return true;
  return new Promise((resolve, reject) => {
    stream.write(buffer, (err) => (err ? reject(err) : resolve(true)));
  });
});

ipcMain.handle('desktop:writeFileEnd', async (_event, filePath) => {
  const stream = desktopWriteStreams.get(filePath);
  if (!stream) throw new Error('No hay escritura activa para ese archivo.');
  desktopWriteStreams.delete(filePath);
  return new Promise((resolve, reject) => {
    stream.end(() => resolve(true));
    stream.once('error', reject);
  });
});

ipcMain.handle('desktop:writeFilesToFolder', async (_event, folderPath, files) => {
  if (!folderPath) throw new Error('Carpeta vacía.');
  if (!fs.existsSync(folderPath)) await fsp.mkdir(folderPath, { recursive: true });
  for (const file of files || []) {
    const dest = path.join(folderPath, file.name);
    await fsp.writeFile(dest, Buffer.from(file.data));
  }
  writeConfig({ workingFolder: folderPath });
  return true;
});

ipcMain.handle('desktop:revealInFolder', async (_event, targetPath) => {
  if (!targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});
