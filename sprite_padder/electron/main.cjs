const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, nativeImage } = require('electron');
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

ipcMain.handle('desktop:pickFolder', async (_event, options = {}) => {
  const current = getWorkingFolder();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Elegir carpeta de trabajo',
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
  const suggestedName = options.suggestedName || 'export.bin';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Guardar archivo',
    defaultPath: path.join(current?.path || app.getPath('documents'), suggestedName),
    filters: options.filters || [{ name: 'Todos', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;

  let filePath = result.filePath;
  const suggestedExt = path.extname(suggestedName);
  if (suggestedExt && !path.extname(filePath)) filePath += suggestedExt;

  const parent = path.dirname(filePath);
  if (fs.existsSync(parent)) writeConfig({ workingFolder: parent });
  return filePath;
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

/** Copia PNGs al portapapeles de Windows como archivos separados (y como imagen si hay uno solo). */
ipcMain.handle('desktop:copyImagesToClipboard', async (_event, files) => {
  if (!Array.isArray(files) || files.length === 0) return false;

  const dir = path.join(app.getPath('temp'), 'joa-sprite-clipboard');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  const used = new Set();
  const paths = [];
  let firstBuffer = null;

  for (const file of files) {
    if (!file || !file.data) continue;
    const rawName = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'sprite.png';
    let base = path.basename(rawName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    if (!/\.png$/i.test(base)) base = `${base.replace(/\.[^.]+$/, '') || 'sprite'}.png`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const stem = base.replace(/\.png$/i, '');
      name = `${stem}_${n}.png`;
      n += 1;
    }
    used.add(name.toLowerCase());

    const buf = Buffer.from(file.data);
    if (!firstBuffer) firstBuffer = buf;
    const dest = path.join(dir, name);
    await fsp.writeFile(dest, buf);
    paths.push(dest);
  }

  if (paths.length === 0) return false;

  const payload = { files: paths };
  if (paths.length === 1 && firstBuffer) {
    const image = nativeImage.createFromBuffer(firstBuffer);
    if (!image.isEmpty()) payload.image = image;
  }
  clipboard.write(payload);
  return true;
});
