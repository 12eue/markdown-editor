# Markdown Editor

基于 Electron 的本地 Markdown 阅读与编辑器，支持打开文件或文件夹、文件夹树浏览、文档目录导航、实时预览、深浅主题，以及 Windows 和 macOS（x64 + arm64）安装包构建。

## 功能

- 可收缩/展开的左侧边栏，顶部提供两个选项卡：
  - 文件夹：浏览已打开目录的文件树，懒加载子目录
  - 目录：当前文档的标题大纲，点击可在预览区或编辑区定位到对应标题
- 打开 Markdown 文件或整个文件夹，支持打开文件对话框
- 编辑与阅读一体：编辑区使用 CodeMirror，右侧实时预览（marked + DOMPurify + highlight.js）
- 三种视图：仅编辑、编辑与预览分屏、仅预览
- 本地图片与相对链接支持（预览中相对路径的图片会解析为本地文件）
- 保存（Ctrl/Cmd+S）、另存为（Ctrl/Cmd+Shift+S）、未保存状态提示与关闭前确认
- 应用启动时默认显示空白页；双击 Markdown 文件用本应用打开时，直接展示该文件内容
- 记忆窗口内 UI 偏好（主题、视图模式、侧边栏状态、选项卡）

## 开发

环境要求：Node.js 18+。

```bash
npm install
npm start
```

渲染层使用 esbuild 打包，源码位于 `src/renderer/`，产物输出到 `renderer/`。

## 打包

```bash
# Windows x64（NSIS 安装包）
npm run build:win

# macOS x64 + arm64（dmg + zip）
npm run build:mac

# macOS Universal（同时支持 x64 与 arm64 的单个包）
npm run build:mac:universal
```

打包配置见 `electron-builder.yml`。macOS 的 `dmg` 产物需要在 macOS 环境生成；仓库内置的 GitHub Actions 工作流（`.github/workflows/build.yml`）会在 Windows 与 macOS 两个 runner 上分别构建并上传安装包。

## 项目结构

```text
main.js                    Electron 主进程：窗口、菜单、对话框、文件读写 IPC
preload.js                 预加载脚本，通过 contextBridge 暴露安全接口
src/renderer/main.js       渲染层逻辑：编辑器、预览、目录树、目录大纲
src/renderer/styles.css    界面样式
renderer/index.html        渲染层入口
electron-builder.yml       打包配置
scripts/make-icon.js       应用图标生成脚本
```
