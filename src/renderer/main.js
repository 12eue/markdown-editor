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
  createElement,
  X,
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
  X,
};

const state = {
  tabs: [],
  activeTabIndex: -1,
  currentFile: null,
  currentDir: null,
  folderRoots: [],
  lastDialogDir: null,
  expanded: new Set(),
  dirty: false,
  sidebarOpen: true,
  activeTab: 'files',
  viewMode: 'split',
  dark: localStorage.getItem('md-theme') === 'dark',
};

const tocEntries = [];
let switchingTabs = false;
let previewTimer = null;
let previewRenderId = 0;
let tabElements = [];
let scrollSyncBusy = false;
let scrollSyncTimer = null;
let lastScrollSource = 'editor';

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
const fileTabsEl = document.getElementById('file-tabs');
const tocListEl = document.getElementById('toc-list');
const editorHostEl = document.getElementById('editor');
const editorEmptyEl = document.getElementById('editor-empty');
const previewEl = document.getElementById('preview');
const previewEmptyEl = document.getElementById('preview-empty');
const statusFileEl = document.getElementById('status-file');
const statusMetaEl = document.getElementById('status-meta');
const statusStateEl = document.getElementById('status-state');

const nodeMap = new Map();
const folderRootEls = new Map();

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
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
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !switchingTabs) onDocChanged();
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

function makeIcon(iconNode, className = '') {
  const el = createElement(iconNode, { class: className, 'aria-hidden': 'true' });
  return el;
}

function replaceButtonIcon(button, iconNode) {
  const old = button.querySelector('svg, [data-lucide]');
  const icon = makeIcon(iconNode);
  if (old) old.replaceWith(icon);
  else button.prepend(icon);
}

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

function dirOf(p) {
  const i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
  return i > 0 ? String(p).slice(0, i) : '';
}

function isMarkdownPath(p) {
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(String(p));
}

function normalizeEol(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function detectEol(text) {
  const match = String(text).match(/\r\n|\r|\n/);
  return match ? match[0] : '\n';
}

function textForSave(text, eol) {
  if (eol === '\r\n') return String(text).replace(/\n/g, '\r\n');
  if (eol === '\r') return String(text).replace(/\n/g, '\r');
  return String(text);
}

function clampScrollTop(el, top) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return Math.max(0, Math.min(top, max));
}

function getScrollRatio(el) {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

function currentEditorLine() {
  try {
    const block = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);
    return editor.state.doc.lineAt(block.from).number;
  } catch {
    const lines = editor.state.doc.lines || 1;
    return Math.max(1, Math.min(lines, Math.round(getScrollRatio(editor.scrollDOM) * lines)));
  }
}

function headingEntryBeforeLine(line) {
  let best = null;
  for (const entry of tocEntries) {
    if (entry.line <= line) best = entry;
    else break;
  }
  return best;
}

function headingEntryAtPreviewTop() {
  const top = previewEl.scrollTop;
  let best = null;
  for (const entry of tocEntries) {
    const el = document.getElementById(entry.id);
    if (!el) continue;
    const elTop = el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop;
    if (elTop <= top + 24) best = entry;
    else break;
  }
  return best;
}

function withScrollSync(callback) {
  if (scrollSyncBusy) return;
  scrollSyncBusy = true;
  callback();
  clearTimeout(scrollSyncTimer);
  scrollSyncTimer = setTimeout(() => {
    scrollSyncBusy = false;
  }, 80);
}

function syncPreviewToEditorLine(line) {
  const entry = headingEntryBeforeLine(line);
  if (entry) {
    const el = document.getElementById(entry.id);
    if (el) {
      const top = el.getBoundingClientRect().top - previewEl.getBoundingClientRect().top + previewEl.scrollTop - 12;
      previewEl.scrollTop = clampScrollTop(previewEl, top);
      return;
    }
  }
  const lines = editor.state.doc.lines || 1;
  const ratio = Math.max(0, Math.min(1, (line - 1) / Math.max(1, lines - 1)));
  previewEl.scrollTop = clampScrollTop(previewEl, ratio * (previewEl.scrollHeight - previewEl.clientHeight));
}

function syncEditorToPreviewLine(line) {
  const entry = headingEntryBeforeLine(line);
  if (entry) {
    try {
      const lineObj = editor.state.doc.line(entry.line);
      editor.dispatch({
        effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 12 }),
      });
      return;
    } catch {
      // Fall through to proportional syncing.
    }
  }
  const lines = editor.state.doc.lines || 1;
  const ratio = Math.max(0, Math.min(1, (line - 1) / Math.max(1, lines - 1)));
  editor.scrollDOM.scrollTop = ratio * (editor.scrollDOM.scrollHeight - editor.scrollDOM.clientHeight);
}

function syncPreviewFromEditor() {
  withScrollSync(() => syncPreviewToEditorLine(currentEditorLine()));
}

function previewScrollLine() {
  const entry = headingEntryAtPreviewTop();
  if (entry) return entry.line;
  const lines = editor.state.doc.lines || 1;
  return Math.max(1, Math.round(getScrollRatio(previewEl) * lines) || 1);
}

function syncEditorFromPreview() {
  withScrollSync(() => syncEditorToPreviewLine(previewScrollLine()));
}

function syncPanes(mode) {
  if (mode === 'preview') syncEditorFromPreview();
  else syncPreviewFromEditor();
}

function onEditorScroll() {
  if (state.viewMode !== 'split' || scrollSyncBusy) return;
  lastScrollSource = 'editor';
  withScrollSync(() => syncPreviewToEditorLine(currentEditorLine()));
}

function onPreviewScroll() {
  if (state.viewMode !== 'split' || scrollSyncBusy) return;
  lastScrollSource = 'preview';
  withScrollSync(() => syncEditorToPreviewLine(previewScrollLine()));
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
  const tab = currentTab();
  if (tab) {
    const wasDirty = tab.dirty;
    tab.content = text;
    tab.dirty = text !== tab.savedContent;
    state.dirty = tab.dirty;
    if (tab.dirty !== wasDirty) updateTabDirtyUi(state.activeTabIndex);
  } else {
    state.dirty = false;
  }
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
  previewRenderId += 1;
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
    resolvePreviewPaths(previewEl, baseDir);
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
  requestAnimationFrame(() => syncPanes(state.viewMode));
}

async function resolvePreviewPaths(root, baseDir) {
  const id = ++previewRenderId;
  const jobs = [];
  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^(https?:|data:|file:)/i.test(src)) jobs.push({ kind: 'url', el: img, target: src });
  });
  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (!/^(https?:|mailto:|#|file:)/i.test(href)) {
      jobs.push({ kind: 'path', el: anchor, target: href });
    }
  });
  if (!jobs.length) return;
  try {
    const resolved = await window.mdEditor.resolvePaths(
      jobs.map((job) => ({ baseDir, target: job.target }))
    );
    if (id !== previewRenderId || !root.isConnected) return;
    jobs.forEach((job, index) => {
      if (job.kind === 'url') job.el.setAttribute('src', resolved[index].url);
      else job.el.dataset.file = resolved[index].path;
    });
  } catch {
    // Keep the original references when resolution fails.
  }
}

function htmlToText(html) {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
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
    const plain = htmlToText(entry.text);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.style.setProperty('--level', entry.depth);
    btn.textContent = plain;
    btn.title = plain;
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

function currentTab() {
  return state.tabs[state.activeTabIndex] || null;
}

function makeTab(filePath, content, placeholder = false) {
  const normalized = normalizeEol(content);
  return {
    path: filePath,
    dir: dirOf(filePath),
    name: baseName(filePath),
    savedContent: normalized,
    content: normalized,
    eol: detectEol(content),
    dirty: false,
    placeholder,
  };
}

function activateTab(index) {
  if (index < 0 || index >= state.tabs.length) return;
  const prev = currentTab();
  if (prev) {
    prev.content = editor.state.doc.toString();
    prev.dirty = prev.content !== prev.savedContent;
  }
  state.activeTabIndex = index;
  const tab = state.tabs[index];
  state.currentFile = tab.path;
  state.currentDir = tab.dir;
  state.dirty = tab.dirty;
  window.mdEditor.setDirty(state.dirty);
  switchingTabs = true;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: tab.content },
    effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(Boolean(tab.placeholder))),
  });
  switchingTabs = false;
  updateDirtyUi();
  renderMarkdown(tab.content, tab.dir);
  highlightCurrent();
  renderTabs();
}

function setActiveTab(index) {
  if (index === state.activeTabIndex) return;
  activateTab(index);
}

function renderTabs() {
  fileTabsEl.innerHTML = '';
  tabElements = [];
  if (!state.tabs.length) {
    fileTabsEl.classList.add('hidden');
    return;
  }
  fileTabsEl.classList.remove('hidden');
  state.tabs.forEach((tab, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'file-tab' + (index === state.activeTabIndex ? ' active' : '');
    btn.title = tab.path;

    const name = document.createElement('span');
    name.className = 'tab-name' + (tab.dirty ? ' dirty' : '');
    name.textContent = tab.name;
    btn.appendChild(name);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.title = '关闭';
    close.appendChild(makeIcon(ICONS.X));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(index);
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => setActiveTab(index));
    fileTabsEl.appendChild(btn);
    tabElements.push(btn);
  });
  const active = fileTabsEl.querySelector('.file-tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTabDirtyUi(index) {
  const btn = tabElements[index];
  const tab = state.tabs[index];
  if (!btn || !tab) return;
  btn.classList.toggle('dirty', tab.dirty);
  btn.querySelector('.tab-name')?.classList.toggle('dirty', tab.dirty);
}

function closeTab(index) {
  const tab = state.tabs[index];
  if (!tab) return;
  if (tab.dirty && !window.confirm(`关闭前保存对“${tab.name}”的更改？未保存的更改将丢失。`)) {
    return;
  }
  const wasActive = index === state.activeTabIndex;
  state.tabs.splice(index, 1);
  if (wasActive) {
    state.activeTabIndex = -1;
    state.currentFile = null;
    state.currentDir = null;
    state.dirty = false;
    window.mdEditor.setDirty(false);
    if (state.tabs.length) {
      activateTab(Math.min(index, state.tabs.length - 1));
    } else {
      switchingTabs = true;
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: '' },
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(false)),
      });
      switchingTabs = false;
      updateDirtyUi();
      renderMarkdown('', null);
      renderTabs();
    }
  } else {
    if (index < state.activeTabIndex) state.activeTabIndex -= 1;
    renderTabs();
  }
  highlightCurrent();
}

function openPlaceholderFile(filePath) {
  const existingIndex = state.tabs.findIndex((tab) => tab.path === filePath);
  if (existingIndex !== -1) {
    setActiveTab(existingIndex);
    return;
  }
  state.lastDialogDir = dirOf(filePath);
  state.tabs.push(makeTab(filePath, '', true));
  activateTab(state.tabs.length - 1);
}

async function openFileByPath(filePath) {
  if (!isMarkdownPath(filePath)) {
    openPlaceholderFile(filePath);
    return;
  }
  const existingIndex = state.tabs.findIndex((tab) => tab.path === filePath);
  if (existingIndex !== -1) {
    setActiveTab(existingIndex);
    return;
  }
  try {
    const content = await window.mdEditor.readText(filePath);
    state.lastDialogDir = dirOf(filePath);
    state.tabs.push(makeTab(filePath, content));
    activateTab(state.tabs.length - 1);
  } catch (err) {
    toast('无法打开文件：' + err.message, 'error');
  }
}

async function openFileDialog() {
  const filePaths = await window.mdEditor.openFileDialog(getDefaultDialogDir());
  for (const filePath of filePaths || []) {
    await openFileByPath(filePath);
  }
}

function getDefaultDialogDir() {
  return state.lastDialogDir || state.currentDir || null;
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
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.mdEditor.showContextMenu({ target: entry.path, isDirectory: entry.isDirectory });
  });

  const chevron = document.createElement('span');
  chevron.className = 'chevron';

  if (entry.isDirectory) {
    chevron.appendChild(makeIcon(ICONS.ChevronRight));
    row.appendChild(chevron);
    row.appendChild(makeIcon(ICONS.Folder, 'type-icon folder'));

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
  row.appendChild(makeIcon(entry.isMarkdown ? ICONS.FileText : ICONS.File, 'type-icon'));

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
  row.addEventListener('click', () => {
    if (entry.isMarkdown) openFileByPath(entry.path);
    else openPlaceholderFile(entry.path);
  });
  return li;
}

async function loadChildren(node) {
  if (node.dataset.loaded === 'true') return;
  const entries = await window.mdEditor.readDir(node.dataset.path);
  node.dataset.loaded = 'true';
  node._entries = entries;
  const ul = node.querySelector(':scope > ul');
  const depth = Number(node.dataset.depth || 0);
  for (const entry of entries) ul.appendChild(makeTreeNode(entry, depth + 1));
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

async function loadFolder(rootPath, { expand = true } = {}) {
  if (!state.folderRoots.includes(rootPath)) state.folderRoots.push(rootPath);
  const wrapper = document.createElement('div');
  wrapper.className = 'folder-root';
  const rootNode = makeTreeNode(
    { path: rootPath, name: baseName(rootPath) || rootPath, isDirectory: true, isFile: false, isMarkdown: false },
    0
  );
  rootNode.classList.add('folder-root-node');
  wrapper.appendChild(rootNode);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'folder-close';
  closeBtn.title = '关闭文件夹';
  closeBtn.appendChild(makeIcon(ICONS.X));
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    closeFolder(rootPath);
  });
  rootNode.querySelector(':scope > .tree-row').appendChild(closeBtn);
  folderRootEls.set(rootPath, wrapper);
  fileTreeEl.appendChild(wrapper);
  if (expand) await expandNode(rootNode);
  treeEmptyEl.classList.add('hidden');
  fileTreeEl.classList.remove('hidden');
  updateSidebarTitle();
  return rootNode;
}

async function refreshTree() {
  const tab = currentTab();
  if (tab && tab.dirty && !window.confirm(`“${tab.name}”有未保存的更改，刷新将丢失这些更改。确定继续吗？`)) {
    return;
  }
  if (!state.folderRoots.length) {
    await reloadCurrentFile();
    return;
  }
  const roots = [...state.folderRoots];
  const wanted = new Set(state.expanded);
  nodeMap.clear();
  folderRootEls.clear();
  fileTreeEl.innerHTML = '';
  for (const rootPath of roots) {
    await loadFolder(rootPath, { expand: wanted.has(rootPath) });
  }
  for (const p of wanted) {
    const node = nodeMap.get(p);
    if (node) await expandNode(node);
  }
  highlightCurrent();
  await reloadCurrentFile();
}

async function reloadCurrentFile() {
  const tab = currentTab();
  if (!tab) return;
  try {
    const content = await window.mdEditor.readText(tab.path);
    const normalized = normalizeEol(content);
    tab.savedContent = normalized;
    tab.content = normalized;
    tab.eol = detectEol(content);
    tab.dirty = false;
    state.dirty = false;
    state.currentFile = tab.path;
    state.currentDir = tab.dir;
    window.mdEditor.setDirty(false);
    switchingTabs = true;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: normalized },
    });
    switchingTabs = false;
    editor.scrollDOM.scrollTop = 0;
    renderMarkdown(normalized, tab.dir);
    updateDirtyUi();
    renderTabs();
    toast('已重新加载当前文件');
  } catch (err) {
    toast('重新加载失败：' + err.message, 'error');
  }
}

function closeFolder(rootPath) {
  const wrapper = folderRootEls.get(rootPath);
  if (!wrapper) return;
  wrapper.remove();
  folderRootEls.delete(rootPath);
  state.folderRoots = state.folderRoots.filter((p) => p !== rootPath);
  const sep = rootPath.includes('\\') ? '\\' : '/';
  const prefix = rootPath.replace(/[\\/]+$/, '') + sep;
  for (const key of [...nodeMap.keys()]) {
    if (key === rootPath || key.startsWith(prefix)) nodeMap.delete(key);
  }
  for (const key of [...state.expanded]) {
    if (key === rootPath || key.startsWith(prefix)) state.expanded.delete(key);
  }
  if (state.lastDialogDir && (state.lastDialogDir === rootPath || state.lastDialogDir.startsWith(prefix))) {
    state.lastDialogDir = state.folderRoots[state.folderRoots.length - 1] || state.currentDir || null;
  }
  if (!state.folderRoots.length) {
    fileTreeEl.classList.add('hidden');
    treeEmptyEl.classList.remove('hidden');
  }
  updateSidebarTitle();
  highlightCurrent();
}

function updateSidebarTitle() {
  const count = state.folderRoots.length;
  sidebarTitleEl.textContent = count ? `${count} 个文件夹` : '未打开文件夹';
  sidebarTitleEl.title = count ? state.folderRoots.join('\n') : '';
}

function highlightCurrent() {
  fileTreeEl.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
  if (!state.currentFile) return;
  const node = nodeMap.get(state.currentFile);
  if (node) node.querySelector(':scope > .tree-row').classList.add('active');
}

async function openFolderDialog() {
  const folderPaths = await window.mdEditor.openFolderDialog(getDefaultDialogDir());
  for (const folderPath of folderPaths || []) {
    if (state.folderRoots.includes(folderPath)) {
      const existing = nodeMap.get(folderPath);
      if (existing && !existing.classList.contains('expanded')) await toggleDir(existing);
      state.lastDialogDir = folderPath;
      continue;
    }
    const rootNode = await loadFolder(folderPath);
    state.lastDialogDir = folderPath;
    if (!state.tabs.length) {
      const readme = (rootNode._entries || []).find(
        (entry) => entry.isFile && /^readme\.(md|markdown|mdown|txt)$/i.test(entry.name)
      );
      if (readme) await openFileByPath(readme.path);
    }
  }
}

async function saveFile() {
  const tab = currentTab();
  if (!tab) return saveFileAs();
  if (tab.placeholder) {
    toast('该文件仅支持预览，不能保存', 'error');
    return;
  }
  const text = editor.state.doc.toString();
  try {
    await window.mdEditor.writeText(tab.path, textForSave(text, tab.eol));
    tab.savedContent = text;
    tab.content = text;
    tab.dirty = false;
    state.dirty = false;
    window.mdEditor.setDirty(false);
    updateDirtyUi();
    renderTabs();
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  }
}

async function saveFileAs() {
  const text = editor.state.doc.toString();
  const defaultPath = currentTab() ? baseName(currentTab().path) : '未命名.md';
  try {
    const output = currentTab() ? textForSave(text, currentTab().eol) : text;
    const filePath = await window.mdEditor.saveFileDialog(defaultPath, output);
    if (!filePath) return;
    if (currentTab()) {
      const tab = currentTab();
      tab.path = filePath;
      tab.dir = dirOf(filePath);
      tab.name = baseName(filePath);
      tab.savedContent = text;
      tab.content = text;
      tab.eol = detectEol(output);
      tab.dirty = false;
      state.currentFile = filePath;
      state.currentDir = tab.dir;
      state.dirty = false;
      state.lastDialogDir = tab.dir;
    } else {
      state.tabs.push(makeTab(filePath, text));
      state.lastDialogDir = dirOf(filePath);
      activateTab(state.tabs.length - 1);
    }
    window.mdEditor.setDirty(false);
    updateDirtyUi();
    renderTabs();
    highlightCurrent();
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  }
}

function setSidebar(open) {
  state.sidebarOpen = open;
  appEl.classList.toggle('sidebar-collapsed', !open);
  localStorage.setItem('md-sidebar', open ? '1' : '0');
  replaceButtonIcon(sidebarToggleBtn, open ? ICONS.PanelLeftClose : ICONS.PanelLeftOpen);
  sidebarToggleBtn.title = open ? '收起侧边栏' : '展开侧边栏';
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
  const prevMode = state.viewMode;
  let pendingSync = null;
  const sourceIsPreview = prevMode === 'preview' || (prevMode === 'split' && lastScrollSource === 'preview');
  if (sourceIsPreview) {
    const line = previewScrollLine();
    pendingSync = () => withScrollSync(() => syncEditorToPreviewLine(line));
  } else {
    const line = currentEditorLine();
    pendingSync = () => withScrollSync(() => syncPreviewToEditorLine(line));
  }
  state.viewMode = mode;
  appEl.dataset.mode = mode;
  viewModeEl.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  localStorage.setItem('md-mode', mode);
  updatePanels();
  requestAnimationFrame(pendingSync);
}

function setTheme(dark) {
  state.dark = dark;
  document.body.classList.toggle('dark', dark);
  localStorage.setItem('md-theme', dark ? 'dark' : 'light');
  editor.dispatch({
    effects: themeCompartment.reconfigure(dark ? oneDark : []),
  });
  replaceButtonIcon(themeToggleBtn, dark ? ICONS.Sun : ICONS.Moon);
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
  editor.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true });
  previewEl.addEventListener('scroll', onPreviewScroll, { passive: true });

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
      if (isMarkdownPath(anchor.dataset.file)) openFileByPath(anchor.dataset.file);
      else openPlaceholderFile(anchor.dataset.file);
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
    record(getDefaultDialogDir() === dirOf(smokeFile));
    const heading = previewEl.querySelector('h1');
    record(heading && heading.textContent.includes('冒烟测试'));
    record(tocListEl.querySelectorAll('.toc-item').length >= 2);
    const tocItemsAll = tocListEl.querySelectorAll('.toc-item');
    const htmlTagItem = tocItemsAll[tocItemsAll.length - 1];
    record(Boolean(htmlTagItem) && htmlTagItem.textContent.includes('使用 标签'));

    setViewMode('split');
    editor.scrollDOM.scrollTop = 120;
    await new Promise((resolve) => setTimeout(resolve, 180));
    record(previewEl.scrollTop > 0);

    setViewMode('edit');
    previewEl.scrollTop = 0;
    setViewMode('preview');
    await new Promise((resolve) => setTimeout(resolve, 180));
    record(previewEl.scrollTop > 0);

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
      const notePath = pathJoin(smokeFolder, '子目录', '笔记.md');
      const crlfPath = pathJoin(smokeFolder, 'crlf.md');
      await openFileByPath(crlfPath);
      record(!state.tabs[state.tabs.length - 1].dirty);
      await openFileByPath(notePath);
      record(state.tabs.length === 3);
      record(tabElements.length === 3);
      record(!state.tabs.find((tab) => tab.path === crlfPath).dirty);
      setActiveTab(0);
      record(editor.state.doc.toString().includes('# 冒烟测试'));
      setActiveTab(2);
      record(editor.state.doc.toString().includes('# 笔记'));
    }

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
      const jsonPath = pathJoin(smokeFolder, '子目录', '数据.json');
      const jsonNode = nodeMap.get(jsonPath);
      if (jsonNode) {
        jsonNode.querySelector(':scope > .tree-row').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const placeholderTab = state.tabs[state.tabs.length - 1];
        record(Boolean(placeholderTab) && placeholderTab.placeholder === true);
        record(!previewEmptyEl.classList.contains('hidden'));
      } else {
        record(false);
      }
      setTab('toc');
      record(!tocViewEl.classList.contains('hidden'));
    }

    const folder2 = params.get('folder2');
    if (folder2) {
      await loadFolder(folder2);
      record(state.folderRoots.length === 2);
      record(fileTreeEl.querySelectorAll('.folder-root').length >= 2);
      const closeBtn = fileTreeEl.querySelector('.folder-root-node > .tree-row .folder-close');
      record(Boolean(closeBtn));
      closeFolder(smokeFolder);
      record(state.folderRoots.length === 1);
      record(!nodeMap.has(smokeFolder));
      record(fileTreeEl.querySelectorAll('.folder-root').length === 1);
    }

    window.mdEditor.report(results.every(Boolean) ? 'OK' : 'FAIL ' + JSON.stringify(results));
  } catch (err) {
    window.mdEditor.report('ERR ' + (err && err.message ? err.message : String(err)));
  }
}

function pathJoin(base, ...names) {
  const sep = base.includes('\\') ? '\\' : '/';
  return names.reduce((acc, name) => acc.replace(/[\\/]+$/, '') + sep + name, base);
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
