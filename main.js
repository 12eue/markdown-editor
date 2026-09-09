const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let pendingFile = null;
let isDirty = false;
let allowClose = false;
let smokeTimer = null;
const isSmoke = process.argv.includes('--smoke-test');

function extractFileArg(argv) {
  for (const arg of argv) {
    if (arg.startsWith('-') || arg === '.' || arg === '--') continue;
    try {
      const st = fsSync.statSync(arg);
      if (st.isFile()) return path.resolve(arg);
    } catch {
      // Ignore arguments that are not existing files.
    }
  }
  return null;
}

async function readText(filePath) {
  let raw = await fs.readFile(filePath, 'utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return raw;
}

async function writeText(filePath, content) {
  await fs.writeFile(filePath, content, 'utf-8');
}

async function listDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .map((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const isDirectory = entry.isDirectory();
      const isFile = entry.isFile();
      return {
        name: entry.name,
        path: fullPath,
        isDirectory,
        isFile,
        isMarkdown: isFile && /\.(md|markdown|mdown|mkd|txt)$/i.test(entry.name),
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
}

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function registerIpc() {
  ipcMain.handle('dialog:open-file', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 Markdown 文件',
      defaultPath: defaultPath || undefined,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Markdown 文件', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:open-folder', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开文件夹',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:save-file', async (_event, { defaultPath, content }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存 Markdown 文件',
      defaultPath,
      filters: [
        { name: 'Markdown 文件', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    await writeText(result.filePath, content);
    return result.filePath;
  });

  ipcMain.handle('fs:read-text', (_event, filePath) => readText(filePath));
  ipcMain.handle('fs:write-text', (_event, { path: filePath, content }) => writeText(filePath, content));
  ipcMain.handle('fs:read-dir', (_event, dirPath) => listDir(dirPath));
  ipcMain.handle('fs:open-path', (_event, target) => shell.openPath(target));
  ipcMain.handle('shell:open-external', (_event, url) => shell.openExternal(url));

  ipcMain.handle('fs:resolve-paths', (_event, items) => {
    return items.map(({ baseDir, target }) => {
      let decoded = target;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // Keep the original target when decoding fails.
      }
      const resolvedPath = path.resolve(baseDir, decoded);
      return { url: pathToFileURL(resolvedPath).href, path: resolvedPath };
    });
  });

  ipcMain.on('window:set-dirty', (_event, dirty) => {
    isDirty = Boolean(dirty);
  });
  ipcMain.on('app:report', (_event, payload) => {
    if (!isSmoke) return;
    console.log('[smoke] ' + payload);
    clearTimeout(smokeTimer);
    app.exit(payload === 'OK' ? 0 : 1);
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件…',
          accelerator: 'CmdOrCtrl+O',
          registerAccelerator: !isMac,
          click: () => sendToRenderer('menu-action', 'open-file'),
        },
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+Shift+O',
          registerAccelerator: !isMac,
          click: () => sendToRenderer('menu-action', 'open-folder'),
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          registerAccelerator: !isMac,
          click: () => sendToRenderer('menu-action', 'save'),
        },
        {
          label: '另存为…',
          accelerator: 'CmdOrCtrl+Shift+S',
          registerAccelerator: !isMac,
          click: () => sendToRenderer('menu-action', 'save-as'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Markdown Editor',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'Markdown Editor',
              detail: '基于 Electron 的本地 Markdown 阅读与编辑器。',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 820,
    minWidth: 1100,
    minHeight: 600,
    title: 'Markdown Editor',
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  let smokeFile = '';
  let smokeFolder = '';
  let smokeFolder2 = '';
  if (isSmoke) {
    const tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'md-editor-smoke-'));
    smokeFile = path.join(tempDir, '示例.md');
    smokeFolder = path.join(tempDir, '示例文件夹');
    smokeFolder2 = path.join(tempDir, '第二文件夹');
    await fs.mkdir(path.join(smokeFolder, '子目录'), { recursive: true });
    await fs.writeFile(path.join(smokeFolder, 'README.md'), '# 文件夹测试\n\n内容。\n', 'utf-8');
    await fs.writeFile(path.join(smokeFolder, '子目录', '笔记.md'), '# 笔记\n', 'utf-8');
    await fs.writeFile(path.join(smokeFolder, '子目录', '数据.json'), '{}\n', 'utf-8');
    await fs.mkdir(smokeFolder2, { recursive: true });
    await fs.writeFile(path.join(smokeFolder2, '说明.md'), '# 说明\n', 'utf-8');
    const sample = [
      '# 冒烟测试',
      '',
      '这是用于验证应用启动、文件读取、预览和目录导航的示例文档。',
      '',
      '## 标题二',
      '',
      '- 项目一',
      '- 项目二',
      '',
      '```js',
      'const message = "hello";',
      'console.log(message);',
      '```',
      '',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| 文件读取 | 通过 |',
      '',
      '## 使用 <code>标签</code>',
      '',
    ].join('\n');
    await fs.writeFile(smokeFile, sample, 'utf-8');
    smokeTimer = setTimeout(() => {
      console.error('[smoke] timeout');
      app.exit(1);
    }, 20000);
  }

  const initialFile = smokeFile || pendingFile || extractFileArg(process.argv.slice(1));
  pendingFile = null;

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { smoke: isSmoke ? '1' : '0', file: initialFile, folder: smokeFolder, folder2: smokeFolder2 },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (allowClose || !isDirty) return;
    event.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['放弃更改并关闭', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '当前文件有未保存的更改',
        detail: '关闭窗口将丢失未保存的修改。',
      })
      .then(({ response }) => {
        if (response === 0) {
          allowClose = true;
          mainWindow.close();
        }
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = extractFileArg(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) sendToRenderer('file-open', file);
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToRenderer('file-open', filePath);
    } else {
      pendingFile = filePath;
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    buildMenu();
    await createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
