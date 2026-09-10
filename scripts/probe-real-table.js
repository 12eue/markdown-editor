const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');

const targetFile = process.argv[process.argv.length - 1];

function readText(filePath) {
  return fs.readFile(filePath, 'utf-8');
}

app.whenReady().then(async () => {
  ipcMain.handle('fs:read-text', (_event, filePath) => readText(filePath));
  ipcMain.handle('fs:read-dir', async (_event, dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isMarkdown: entry.isFile() && /\.(md|markdown|mdown|mkd|txt)$/i.test(entry.name),
    }));
  });
  ipcMain.handle('fs:resolve-paths', (_event, items) => {
    return items.map(({ baseDir, target }) => {
      const resolvedPath = path.resolve(baseDir, decodeURIComponent(target));
      return { url: pathToFileURL(resolvedPath).href, path: resolvedPath };
    });
  });
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { smoke: '0', file: targetFile },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const result = await win.webContents.executeJavaScript(`(() => {
    const md = document.querySelector('.markdown-body');
    const pv = document.getElementById('preview');
    const tables = [...pv.querySelectorAll('table')].map((t) => {
      const r = t.getBoundingClientRect();
      const wrapper = t.parentElement;
      return {
        wrapperClass: wrapper ? wrapper.className : '',
        cols: t.rows && t.rows[0] ? t.rows[0].cells.length : 0,
        width: Math.round(r.width),
        clientWidth: t.clientWidth,
        scrollWidth: t.scrollWidth,
        mdClientWidth: md.clientWidth,
        firstCell: t.rows && t.rows[0] ? t.rows[0].cells[0].textContent.trim().slice(0, 20) : '',
      };
    });
    return JSON.stringify({
      mdClientWidth: md.clientWidth,
      previewClientWidth: pv.clientWidth,
      previewScrollWidth: pv.scrollWidth,
      tables,
    });
  })()`);
  console.log(result);
  const image = await win.webContents.capturePage();
  fsSync.writeFileSync(path.join(__dirname, 'probe-table.png'), image.toPNG());
  app.exit(0);
});
