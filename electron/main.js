// Electron main process: one window running index.html, plus native file dialogs and file writes.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Same ID as the installer's shortcuts (package.json build.appId), so a pinned taskbar icon and the
// running window are one icon on Windows.
app.setAppUserModelId('com.seski.2k5playbookmanager');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
// The app was renamed from "2K5 Playbook Porter"; carry its remembered folders over once.
const OLD_SETTINGS_FILE = path.join(app.getPath('appData'), '2K5 Playbook Porter', 'settings.json');
try {
  if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(OLD_SETTINGS_FILE)) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.copyFileSync(OLD_SETTINGS_FILE, SETTINGS_FILE);
  }
} catch { /* not critical */ }
// Only these files are read from a chosen Xbox folder; everything else (rosters, franchises) is skipped.
const XBOX_FILE_NAMES = new Set(['savegame.dat', 'savemeta.xbx']);
const MAX_SCAN_DEPTH = 4;

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* not critical */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 420,
    minHeight: 500,
    autoHideMenuBar: true,
    backgroundColor: '#0f1216',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The app never opens other pages; refuse popups and navigation (e.g. a file dropped outside a drop zone).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  return win;
}

// Walks a chosen folder for Xbox save files. Paths are relative to the folder's parent,
// so "53450030/004200550046/SAVEGAME.DAT" groups the same way a browser folder pick does.
function scanXboxFolder(root) {
  const base = path.dirname(root);
  const items = [];
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) walk(full, depth + 1);
      } else if (XBOX_FILE_NAMES.has(entry.name.toLowerCase())) {
        const data = fs.readFileSync(full);
        items.push({
          name: entry.name,
          path: path.relative(base, full).split(path.sep).join('/'),
          size: data.length,
          data: new Uint8Array(data.buffer, data.byteOffset, data.length),
        });
      }
    }
  }
  walk(root, 0);
  return items;
}

ipcMain.handle('pick-xbox-folder', async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose an Xbox playbook save folder',
    defaultPath: loadSettings().xboxFolder,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  saveSetting('xboxFolder', folder);
  return scanXboxFolder(folder);
});

ipcMain.handle('save-file', async (event, fileName, bytes) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const outputFolder = loadSettings().outputFolder;
  const result = await dialog.showSaveDialog(win, {
    title: 'Save PS2 playbook',
    defaultPath: outputFolder ? path.join(outputFolder, fileName) : fileName,
    filters: [{ name: 'PS2 save', extensions: [path.extname(fileName).slice(1)] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, Buffer.from(bytes));
  saveSetting('outputFolder', path.dirname(result.filePath));
  return result.filePath;
});

ipcMain.handle('save-files-to-folder', async (event, files) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the PS2 saves',
    defaultPath: loadSettings().outputFolder,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  const written = [];
  for (const f of files) {
    const target = path.join(folder, path.basename(f.fileName));
    fs.writeFileSync(target, Buffer.from(f.bytes));
    written.push(target);
  }
  saveSetting('outputFolder', folder);
  return { folder, written };
});

// Writes an Xbox save folder (SAVEGAME.DAT, EXTRA, TYPE, SaveMeta.xbx) inside a chosen parent folder.
// Never overwrites: an existing folder of the same name is refused.
ipcMain.handle('save-xbox-folder', async (event, folderName, files) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!/^[0-9A-F]{12}$/i.test(folderName)) return { error: `Unexpected Xbox save folder name "${folderName}".` };
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to create the Xbox save folder',
    defaultPath: loadSettings().outputFolder,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const parent = result.filePaths[0];
  const target = path.join(parent, folderName);
  if (fs.existsSync(target)) return { error: `${target} already exists. Choose a different folder so the existing save is not overwritten.` };
  fs.mkdirSync(target);
  for (const f of files) fs.writeFileSync(path.join(target, path.basename(f.name)), Buffer.from(f.bytes));
  saveSetting('outputFolder', parent);
  return { folder: target };
});

ipcMain.handle('show-in-folder', (_event, target) => {
  shell.showItemInFolder(target);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
