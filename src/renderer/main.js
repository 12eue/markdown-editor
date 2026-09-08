import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import {
  createIcons,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  FilePlus2,
  Columns2,
  PenLine,
  Eye,
  Save,
  Moon,
  Sun,
  FolderTree,
  ListOrdered,
  RefreshCw,
  ChevronRight,
  Folder,
  File,
  FileText,
  BookOpen,
} from 'lucide';
import './styles.css';
import 'highlight.js/styles/github.css';

const ICONS = {
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  FilePlus2,
  Columns2,
  PenLine,
  Eye,
  Save,
  Moon,
  Sun,
  FolderTree,
  ListOrdered,
  RefreshCw,
  ChevronRight,
  Folder,
  File,
  FileText,
  BookOpen,
};

const state = {
  currentFile: null,
  currentDir: null,
  folderRoot: null,
  expanded: new Set(),
  dirty: false,
  sidebarOpen: true,
  activeTab: 'files',
  viewMode: 'split',
  dark: localStorage.getItem('md-theme') === 'dark',
};

const tocEntries = [];
let savedContent = '';
let previewTimer = null;

const appEl = document.getElementById('app');
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
const openFolderBtn = document.getElementById('open-folder');
const openFileBtn = document.getElementById('open-file');
const saveBtn = document.getElementById('save');
const themeToggleBtn = document.getElementById('theme-toggle');
const viewModeEl = document.getElementById('view-mode');
const sidebarEl = document.getElementById('sidebar');
const filesViewEl = document.getElementById('files-view');
const tocViewEl = document.getElementById('toc-view');
const sidebarTitleEl = document.getElementById('sidebar-title');
const refreshTreeBtn = document.getElementById('refresh-tree');
const treeEmptyEl = document.getElementById('tree-empty');
const fileTreeEl = document.getElementById('file-tree');
const tocListEl = document.getElementById('toc-list');
const editorHostEl = document.getElementById('editor');
const editorEmptyEl = document.getElementById('editor-empty');
const previewEl = document.getElementById('preview');
const previewEmptyEl = document.getElementById('preview-empty');
const statusFileEl = document.getElementById('status-file');
const statusMetaEl = document.getElementById('status-meta');
const statusStateEl = document.getElementById('status-state');

const nodeMap = new Map();

const themeCompartment = new Compartment();
const editor = new EditorView({
  parent: editorHostEl,
  state: EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      themeCompartment.of(state.dark ? oneDark : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onDocChanged();
      }),
    ],
  }),
});

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(text);
      tocEntries.push({ id, text, depth });
      return `<h${depth} id="${id}">${text}</h${depth}>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const isExternal = /^(https?:|mailto:)/.test(href || '');
      const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      const targetAttr = isExternal ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${href}"${titleAttr}${targetAttr}>${text}</a>`;
    },
  },
});

function refreshIcons() {
  createIcons({ icons: ICONS, attrs: { 'stroke-width': 1.8 } });
}

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function dirOf(p) {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return i > 0 ? String(p).slice(0, i) : '';
}

function slugify(text) {
  const plain = String(text).replace(/<[^>]*>/g, '');
  let base = plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}_\-. ]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  base = base.replace(/^-+|-+$/g, '') || 'section';
  let id = base;
  let n = 2;
  while (tocEntries.some((entry) => entry.id === id)) id = `${base}-${n++}`;
  return id;
}

function collectHeadings(source) {
  const result = [];
  const lines = String(source).split('\n');
  let inFence = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      result.push({ depth: match[1].length, text: match[2], line: i + 1 });
    }
  }
  return result;
}

function onDocChanged() {
  const text = editor.state.doc.toString();
  state.dirty = text !== savedContent;
  window.mdEditor.setDirty(state.dirty);
  updateDirtyUi();
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    renderMarkdown(editor.state.doc.toString(), state.currentDir);
  }, 220);
}

function renderMarkdown(source, baseDir) {
  const doc = source == null ? editor.state.doc.toString() : source;
  tocEntries.length = 0;
  const html = marked.parse(doc);
  const headings = collectHeadings(doc);
  for (let i = 0; i < tocEntries.length; i++) {
    if (headings[i]) tocEntries[i].line = headings[i].line;
  }
  const clean = DOMPurify.sanitize(html);
  previewEl.innerHTML = clean;

  if (baseDir) {
    previewEl.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (/^(https?:|data:|file:)/i.test(src)) return;
      try {
        img.setAttribute('src', window.mdEditor.resolveUrl(baseDir, src));
      } catch {
        // Keep the original src when resolution fails.
      }
    });
    previewEl.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (/^(https?:|mailto:|#|file:)/i.test(href)) return;
      try {
        anchor.dataset.file = window.mdEditor.resolvePath(baseDir, href);
      } catch {
        // Keep the original href when resolution fails.
      }
    });
  }

  previewEl.querySelectorAll('pre code').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch {
      // Highlighting is best effort.
    }
  });

  renderToc();
  updatePanels();
}

function renderToc() {
  tocListEl.innerHTML = '';
  if (!tocEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '当前文档没有标题';
    tocListEl.appendChild(empty);
    return;
  }
  for (const entry of tocEntries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.style.setProperty('--level', entry.depth);
    btn.textContent = entry.text;
    btn.title = entry.text;
    btn.addEventListener('click', () => {
      requestAnimationFrame(() => scrollToHeading(entry));
    });
    tocListEl.appendChild(btn);
  }
}

function scrollToHeading(entry) {
  const mode = state.viewMode;
  if (mode === 'edit' || mode === 'split') {
    if (entry.line) {
      try {
        const lineObj = editor.state.doc.line(entry.line);
        editor.dispatch({
          effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 16 }),
          selection: { anchor: lineObj.from },
        });
        if (mode === 'edit') editor.focus();
      } catch {
        // Fall through to the preview pane when the line cannot be resolved.
      }
    }
  }
  if (mode === 'preview' || mode === 'split') {
    const target = document.getElementById(entry.id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function updatePanels() {
  const hasDoc = editor.state.doc.length > 0;
  editorEmptyEl.classList.toggle('hidden', hasDoc);
  previewEmptyEl.classList.toggle('hidden', previewEl.childElementCount > 0);
}

function updateDirtyUi() {
  statusStateEl.textContent = state.dirty ? '未保存' : '已保存';
  statusStateEl.classList.toggle('dirty', state.dirty);
  saveBtn.classList.toggle('dirty', state.dirty);
  updateWindowTitle();
  updateStatus();
}

function updateWindowTitle() {
  const name = state.currentFile ? baseName(state.currentFile) : 'Markdown Editor';
  const mark = state.dirty ? '● ' : '';
  document.title = `${mark}${name} - Markdown Editor`;
}

function updateStatus() {
  const text = editor.state.doc.toString();
  const lines = text ? text.split('\n').length : 0;
  statusFileEl.textContent = state.currentFile || '未打开文件';
  statusFileEl.title = state.currentFile || '';
  statusMetaEl.textContent = `${lines} 行 · ${text.length} 字符`;
}

function setDocument(content, filePath) {
  savedContent = content;
  state.currentFile = filePath || null;
  state.currentDir = filePath ? dirOf(filePath) : null;
  state.dirty = false;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  window.mdEditor.setDirty(false);
  updateDirtyUi();
  renderMarkdown(content, state.currentDir);
  highlightCurrent();
}

async function openFileByPath(filePath) {
  try {
    const content = await window.mdEditor.readText(filePath);
    setDocument(content, filePath);
  } catch (err) {
    toast('无法打开文件：' + err.message, 'error');
  }
}

async function openFileDialog() {
  const filePath = await window.mdEditor.openFileDialog();
  if (filePath) await openFileByPath(filePath);
}

function makeTreeNode(entry, depth) {
  const li = document.createElement('li');
  li.className = 'tree-node';
  li.dataset.path = entry.path;
  li.dataset.depth = String(depth);
  nodeMap.set(entry.path, li);

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = `${6 + depth * 15}px`;

  const chevron = document.createElement('span');
  chevron.className = 'chevron';

  if (entry.isDirectory) {
    chevron.innerHTML = '<i data-lucide="chevron-right"></i>';
    row.appendChild(chevron);

    const icon = document.createElement('i');
    icon.dataset.lucide = 'folder';
    icon.className = 'type-icon folder';
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    name.title = entry.path;
    row.appendChild(name);

    li.appendChild(row);
    li.appendChild(document.createElement('ul'));

    row.addEventListener('click', () => toggleDir(li));
    return li;
  }

  chevron.style.visibility = 'hidden';
  row.appendChild(chevron);

  const icon = document.createElement('i');
  icon.dataset.lucide = entry.isMarkdown ? 'file-text' : 'file';
  icon.className = 'type-icon';
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;
  name.title = entry.path;
  row.appendChild(name);

  if (entry.isMarkdown) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'MD';
    row.appendChild(badge);
  }

  li.appendChild(row);
  row.addEventListener('click', () => openFileByPath(entry.path));
  return li;
}

async function loadChildren(node) {
  if (node.dataset.loaded === 'true') return;
  const entries = await window.mdEditor.readDir(node.dataset.path);
  node.dataset.loaded = 'true';
  const ul = node.querySelector(':scope > ul');
  const depth = Number(node.dataset.depth || 0);
  for (const entry of entries) ul.appendChild(makeTreeNode(entry, depth + 1));
  refreshIcons();
  highlightCurrent();
}

async function toggleDir(node) {
  await loadChildren(node);
  const willOpen = !node.classList.contains('expanded');
  node.classList.toggle('expanded', willOpen);
  if (willOpen) state.expanded.add(node.dataset.path);
  else state.expanded.delete(node.dataset.path);
}

async function expandNode(node) {
  await loadChildren(node);
  node.classList.add('expanded');
  state.expanded.add(node.dataset.path);
}

async function loadFolder(rootPath) {
  state.folderRoot = rootPath;
  state.expanded.clear();
  nodeMap.clear();
  fileTreeEl.innerHTML = '';
  treeEmptyEl.classList.add('hidden');
  fileTreeEl.classList.remove('hidden');

  const rootNode = makeTreeNode(
    { path: rootPath, name: baseName(rootPath) || rootPath, isDirectory: true, isFile: false, isMarkdown: false },
    0
  );
  fileTreeEl.appendChild(rootNode);
  await expandNode(rootNode);
  updateSidebarTitle();
}

async function refreshTree() {
  if (!state.folderRoot) return;
  const wanted = new Set(state.expanded);
  await loadFolder(state.folderRoot);
  for (const p of wanted) {
    const node = nodeMap.get(p);
    if (node) await expandNode(node);
  }
  highlightCurrent();
}

function updateSidebarTitle() {
  sidebarTitleEl.textContent = state.folderRoot ? baseName(state.folderRoot) : '未打开文件夹';
  sidebarTitleEl.title = state.folderRoot || '';
}

function highlightCurrent() {
  fileTreeEl.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
  if (!state.currentFile) return;
  const node = nodeMap.get(state.currentFile);
  if (node) node.querySelector(':scope > .tree-row').classList.add('active');
}

async function openFolderDialog() {
  const folderPath = await window.mdEditor.openFolderDialog();
  if (!folderPath) return;
  await loadFolder(folderPath);
  if (!state.currentFile) {
    try {
      const entries = await window.mdEditor.readDir(folderPath);
      const readme = entries.find(
        (entry) => entry.isFile && /^readme\.(md|markdown|mdown|txt)$/i.test(entry.name)
      );
      if (readme) await openFileByPath(readme.path);
    } catch {
      // Auto-open is best effort.
    }
  }
}

async function saveFile() {
  if (!state.currentFile) return saveFileAs();
  const text = editor.state.doc.toString();
  try {
    await window.mdEditor.writeText(state.currentFile, text);
    savedContent = text;
    state.dirty = false;
    window.mdEditor.setDirty(false);
    updateDirtyUi();
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  }
}

async function saveFileAs() {
  const text = editor.state.doc.toString();
  const defaultPath = state.currentFile ? baseName(state.currentFile) : '未命名.md';
  try {
    const filePath = await window.mdEditor.saveFileDialog(defaultPath, text);
    if (!filePath) return;
    savedContent = text;
    state.currentFile = filePath;
    state.currentDir = dirOf(filePath);
    state.dirty = false;
    window.mdEditor.setDirty(false);
    updateDirtyUi();
    highlightCurrent();
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  }
}

function setSidebar(open) {
  state.sidebarOpen = open;
  appEl.classList.toggle('sidebar-collapsed', !open);
  localStorage.setItem('md-sidebar', open ? '1' : '0');
  const icon = open ? 'panel-left-close' : 'panel-left-open';
  sidebarToggleBtn.querySelector('i')?.setAttribute('data-lucide', icon);
  sidebarToggleBtn.title = open ? '收起侧边栏' : '展开侧边栏';
  refreshIcons();
}

function setTab(tab) {
  state.activeTab = tab;
  const filesActive = tab === 'files';
  filesViewEl.classList.toggle('hidden', !filesActive);
  tocViewEl.classList.toggle('hidden', filesActive);
  document.querySelectorAll('.sidebar-tabs .tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  localStorage.setItem('md-tab', tab);
}

function setViewMode(mode) {
  state.viewMode = mode;
  appEl.dataset.mode = mode;
  viewModeEl.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  localStorage.setItem('md-mode', mode);
  updatePanels();
}

function setTheme(dark) {
  state.dark = dark;
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('md-theme', dark ? 'dark' : 'light');
  editor.dispatch({
    effects: themeCompartment.reconfigure(dark ? oneDark : []),
  });
  themeToggleBtn.querySelector('i')?.setAttribute('data-lucide', dark ? 'sun' : 'moon');
  refreshIcons();
}

function toast(message, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function bindEvents() {
  sidebarToggleBtn.addEventListener('click', () => setSidebar(!state.sidebarOpen));
  openFolderBtn.addEventListener('click', openFolderDialog);
  openFileBtn.addEventListener('click', openFileDialog);
  saveBtn.addEventListener('click', saveFile);
  themeToggleBtn.addEventListener('click', () => setTheme(!state.dark));
  refreshTreeBtn.addEventListener('click', refreshTree);

  document.querySelectorAll('.sidebar-tabs .tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  viewModeEl.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  previewEl.addEventListener('click', (event) => {
    const anchor = event.target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (anchor.dataset.file) {
      event.preventDefault();
      if (/\.(md|markdown|mdown|mkd|txt)$/i.test(anchor.dataset.file)) {
        openFileByPath(anchor.dataset.file);
      } else {
        window.mdEditor.openPath(anchor.dataset.file);
      }
    } else if (/^(https?:|mailto:)/i.test(href)) {
      event.preventDefault();
      window.mdEditor.openExternal(href);
    } else if (href.startsWith('#')) {
      const target = document.getElementById(href.slice(1));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 's' && event.shiftKey) {
      event.preventDefault();
      saveFileAs();
    } else if (key === 's') {
      event.preventDefault();
      saveFile();
    } else if (key === 'o' && event.shiftKey) {
      event.preventDefault();
      openFolderDialog();
    } else if (key === 'o') {
      event.preventDefault();
      openFileDialog();
    }
  });

  window.mdEditor.onMenuAction((action) => {
    if (action === 'open-file') openFileDialog();
    else if (action === 'open-folder') openFolderDialog();
    else if (action === 'save') saveFile();
    else if (action === 'save-as') saveFileAs();
  });

  window.mdEditor.onFileOpen((filePath) => {
    openFileByPath(filePath);
  });
}

async function runSmokeTest(smokeFile) {
  const results = [];
  const record = (ok) => results.push(Boolean(ok));
  try {
    const params = new URLSearchParams(location.search);
    const smokeFolder = params.get('folder');
    await new Promise((resolve) => setTimeout(resolve, 300));
    record(window.mdEditor && typeof window.mdEditor.readText === 'function');
    record(document.getElementById('sidebar'));
    record(editor && typeof editor.state.doc.toString === 'function');
    record(editor.state.doc.toString() === '');

    await openFileByPath(smokeFile);
    await new Promise((resolve) => setTimeout(resolve, 400));

    record(editor.state.doc.toString().includes('# 冒烟测试'));
    const heading = previewEl.querySelector('h1');
    record(heading && heading.textContent.includes('冒烟测试'));
    record(tocListEl.querySelectorAll('.toc-item').length >= 2);

    setViewMode('edit');
    const tocItems = tocListEl.querySelectorAll('.toc-item');
    if (tocItems.length >= 2) {
      tocItems[1].click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const expected = editor.state.doc.line(5).from;
      record(editor.state.selection.main.anchor === expected);
    }

    const outPath = smokeFile + '.out.md';
    const updated = editor.state.doc.toString() + '\n\n> 已保存';
    await window.mdEditor.writeText(outPath, updated);
    const back = await window.mdEditor.readText(outPath);
    record(back === updated);

    if (smokeFolder) {
      await loadFolder(smokeFolder);
      record(fileTreeEl.querySelectorAll('.tree-node').length >= 3);
      const readmeNode = nodeMap.get(pathJoin(smokeFolder, 'README.md'));
      record(Boolean(readmeNode));
      const subDirNode = nodeMap.get(pathJoin(smokeFolder, '子目录'));
      record(Boolean(subDirNode));
      if (subDirNode) {
        await expandNode(subDirNode);
        record(Boolean(nodeMap.get(pathJoin(smokeFolder, '子目录', '笔记.md'))));
      }
      setTab('toc');
      record(!tocViewEl.classList.contains('hidden'));
    }

    window.mdEditor.report(results.every(Boolean) ? 'OK' : 'FAIL ' + JSON.stringify(results));
  } catch (err) {
    window.mdEditor.report('ERR ' + (err && err.message ? err.message : String(err)));
  }
}

function pathJoin(base, name) {
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + name;
}

async function init() {
  setTheme(state.dark);
  setSidebar(localStorage.getItem('md-sidebar') !== '0');
  setViewMode(localStorage.getItem('md-mode') || 'split');
  setTab(localStorage.getItem('md-tab') || 'files');
  refreshIcons();
  bindEvents();
  updateDirtyUi();

  const params = new URLSearchParams(location.search);
  const fileParam = params.get('file');
  const isSmokeRun = params.get('smoke') === '1';
  if (isSmokeRun && fileParam) {
    runSmokeTest(fileParam);
  } else if (fileParam) {
    await openFileByPath(fileParam);
  }
}

init();
