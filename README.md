<p align="center">
  <img src="logo.svg" width="120" alt="TokenWave Logo">
</p>

<h1 align="center">TokenWave</h1>

<p align="center">
  <strong>一键式多Agent编程助手</strong><br>
  Claude Code & Codex CLI，开箱即用
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/electron-33-47848f?style=flat-square&logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
</p>

---

## ✨ 简介

**TokenWave** 是一个开箱即用的多Agent桌面应用，将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic) 和 [Codex CLI](https://github.com/openai/codex) (OpenAI) 两大 AI 编程工具整合到一个统一的界面中。无需复杂的环境配置，开箱即用。

> 本项目 Fork 自 [4Router/4RouterAiApp](https://github.com/4Router/4RouterAiApp)，在其基础上进行了功能扩展与维护。感谢上游项目作者的工作。

<p align="center">
  <img src="docs/images/screenshot.png" alt="TokenWave 应用截图" width="800">
</p>

## 🎯 核心特性

### 🔧 双工具集成
- **Claude Code** — Anthropic 的 AI 编程助手，支持自定义 Base URL 和模型选择
- **Codex CLI** — OpenAI 的命令行编程代理，支持 Reasoning Effort 和 Verbosity 调节

### 👤 账户与一键开通
- **登录 TokenWave** — 内置登录窗口，完成后即可使用账户相关功能
- **一键开通密钥** — 自动为你创建 Claude / Codex 的 API Key 并写入配置，无需手动复制粘贴
- **本地配置导入** — 自动读取本机已有的 `~/.claude` 与 `~/.codex` 配置（hooks、MCP 服务、凭据），导入到应用中开箱即用

### 💰 余额、充值与使用记录
- **余额展示** — 侧栏底部用户区直接显示当前余额，一键刷新
- **应用内充值** — 支付宝直接在程序内弹出二维码并自动轮询到账，无需跳转浏览器；Stripe（信用卡）跳转浏览器完成支付
- **充值价格预览** — 按所选支付渠道实时计算实付金额
- **详细使用记录** — 分页展示每次调用的模型、输入/输出 tokens、**缓存 token 及缓存命中率**、计费倍率、首字延迟（TTFT）等明细

### 💻 快捷终端
- 基于 [xterm.js](https://xtermjs.org/) 的全功能终端模拟器
- **多标签页管理** — 同时运行多个 AI 工具和终端会话，自由切换
- 内置 **复制/粘贴** 工具栏，支持 `Ctrl+C` / `Ctrl+V` 快捷键
- **图片粘贴/拖拽** — 可将剪贴板或拖入的图片作为附件喂给 Claude Code

### 📁 文件浏览器与编辑器
- 侧边面板内置文件树浏览器，自动跟随当前活动标签页的工作目录
- **打开并编辑文件** — 双击文件在新标签页用 [CodeMirror](https://codemirror.net/) 打开，带语法高亮（JS/TS/JSON/CSS/HTML/Markdown/Python），`Ctrl/Cmd+S` 保存
- **目录管理** — 右键菜单支持新建文件、新建文件夹、重命名、删除
- **拖拽移动** — 直接拖动文件/文件夹到目标目录完成移动
- **快捷操作** — 右键「在终端中打开此目录」「复制路径」
- 支持展开/折叠目录结构，刷新后保留展开状态

### 📦 零配置运行环境
- **内置 Node.js 运行时** — 无需全局安装 Node.js
- **内置 MinGit** — Claude Code 运行所需的 Git 环境自动配置（Windows）
- **自动检测更新** — 启动时非阻塞检查 CLI 工具新版本，一键更新

### 🎨 AI 生图
- **文生图 + 图生图** — 输入描述直接生成图片，或上传一张图做编辑/重绘
- **双引擎** — OpenAI 兼容生图（`gpt-image-2`）与 Google `gemini-3.1-flash-image`，模型可下拉预设或自定义；按模型自动切换对应参数
- **丰富参数** — gpt-image 支持尺寸 / 清晰度 / 数量 / 透明背景 / 输出格式 / 压缩率 / 审核宽松度；Gemini 支持宽高比 / 分辨率（1K/2K/4K）
- **生成即存** — 自动落盘到 `generated_images` 并以画廊展示历史，重启不丢；支持点击放大预览、一键在文件夹中显示或复制

### 🧩 扩展管理（MCP & Skills）
- **MCP 服务器** — 在应用内为 **Claude Code 和 Codex** 增删改 MCP 服务器，支持 stdio（本地命令）与 http（远程，仅 Claude）；可逐项启用/禁用，配置自动写入对应 CLI 的配置目录，下次启动该工具时生效
- **Claude Skills** — 创建、编辑（复用内置编辑器打开 `SKILL.md`）、删除、启用/禁用 Claude Code 技能
- **密钥安全** — MCP 的 env / headers 中的敏感值在列表中打码显示，仅保存在本地隔离目录

---

## 📥 安装

前往 [Releases](../../releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| Windows | `TokenWave Setup x.x.x.exe` |
| macOS (Apple Silicon) | `TokenWave-x.x.x-arm64.dmg` |
| macOS (Intel) | `TokenWave-x.x.x-x64.dmg` |

### Windows

双击 `.exe` 安装包运行安装即可。

### macOS

打开 `.dmg`，将 TokenWave 拖入「应用程序」文件夹。

> ⚠️ 由于安装包未经 Apple 公证，首次打开可能提示「已损坏」或「无法验证开发者」。这是 macOS 的安全机制，并非应用损坏。解除方法（dmg 内附《安装说明-必读.txt》有详细步骤）：
>
> ```bash
> # 自动检测安装位置并解除限制，复制整行到终端执行
> for p in /Applications/TokenWave.app ~/Applications/TokenWave.app; do [ -e "$p" ] && xattr -cr "$p" && echo "已解除限制: $p"; done
> ```

---

## 🚀 快速开始

### 1. 首次启动 — 登录并开通密钥

首次启动应用时，你会看到欢迎页面。推荐的最快路径：

1. **登录 TokenWave** — 点击登录，在内置窗口完成登录。
2. **一键开通密钥** — 登录后点击开通，应用会自动为你创建 Claude / Codex 的 API Key 并写入配置。

> 💡 也可以手动在设置页填入自己的 API Key 和 Base URL；或点击「跳过设置」稍后再配置。
> 如果本机已装过 Claude Code / Codex，应用还会提示**导入本地配置**（`~/.claude`、`~/.codex`），沿用你已有的 hooks、MCP 服务和凭据。

### 2. 选择工作目录(可选)

在侧栏的「工作目录」区域点击 📁 按钮，选择你的项目文件夹。所有 AI 工具和终端都将在此目录下运行。

### 3. 启动工具

在侧栏点击对应的工具按钮即可启动：

- 🟣 **Claude Code** — 启动 Anthropic 的 AI 编程助手
- 🟢 **Codex CLI** — 启动 OpenAI 的命令行代理
- ⬛ **Terminal** — 启动一个普通的系统终端（Windows 为 PowerShell，macOS 为默认 shell）

每点击一次都会创建一个新的标签页，你可以同时运行多个会话。

### 4. 在线更新工具

侧栏中的 badge 会显示工具当前版本号。如果检测到新版本，badge 会变为 **「点击更新」** — 直接点击即可一键更新至最新版，无需重新下载安装包。

### 5. 查看余额 / 充值 / 使用记录

点击侧栏底部的 **用户区**（头像 + 余额）打开账户面板：

- **充值** — 选择充值数量，选支付宝（程序内扫码，自动检测到账）或 Stripe（跳转浏览器）完成支付，到账后余额自动刷新。
- **使用记录** — 分页查看每次调用的模型、输入/输出 tokens、缓存 token 与命中率、计费倍率、首字延迟等明细。

> ⚠️ 充值框中填写的是**充值数量**（quota 数量），不是金额。实付金额按各支付渠道的倍率换算，面板会实时预览。

### 6. 生成图片

点击侧栏的 🎨 **生图** 按钮打开生图标签页：

1. 选择**文生图**或**图生图**（图生图需先选一张本地源图）。
2. 选择模型（`gpt-image-2` 或 `gemini-3.1-flash-image`，也可自定义），按需调整尺寸/清晰度、或宽高比/分辨率等参数。
3. 点击「生成」。生成的图片会自动保存到工作目录的 `generated_images` 文件夹，并在下方画廊展示。点击图片可放大预览，悬停可「在文件夹中显示」或「复制」。

> 💡 透明背景需配合 PNG / WebP 格式；不同模型支持的尺寸与参数不同，以实际模型为准。

### 7. 管理 MCP 与 Skills

点击侧栏底部的 🧩 **扩展管理** 按钮：

- **MCP 服务器** — 新增时填写名称、类型（stdio / http）、命令或 URL、env/headers，并勾选要配置到的 CLI（Claude Code / Codex）。保存后写入对应工具的配置目录，**下次启动该工具时生效**。
- **Skills** — 仅对 Claude Code 生效。新增后会自动打开 `SKILL.md` 供你编辑；可随时启用/禁用或删除。

> ⚠️ MCP / Skills 的改动需要重新启动对应的工具会话才会被加载。

---

## ⚙️ 设置

点击侧栏底部的 ⚙️ **设置** 按钮打开设置面板，可配置：

| 设置项               | 说明                                                     |
| -------------------- | -------------------------------------------------------- |
| **API Key**          | Anthropic / OpenAI 的 API 密钥                           |
| **Base URL**         | 自定义 API 端点（支持中转代理）                          |
| **Model**            | 自定义模型名称（如 `opus`、`gpt-5.3-codex`）             |
| **Reasoning Effort** | Codex 的推理力度（如 `xhigh`）                           |
| **Verbosity**        | Codex 的输出详细程度（如 `high`）                        |
| **HTTP(S) 代理**     | 代理地址（如 `http://127.0.0.1:7890`）                   |
| **主题**             | Dark / Light / Fruit                                     |
| **终端字体大小**     | 终端显示字号（默认 14）                                  |
| **终端字体**         | 终端字体族（默认 `JetBrains Mono, Consolas, monospace`） |

> 设置底部还有 **调试信息 — 启动参数预览**，可查看工具实际执行的命令和环境变量。 
> 更改设置后需要打开新的终端标签页才能生效。

---

## 🛠️ 开发

```bash
# 安装依赖
npm install
# 启动开发模式（同时启动 main 进程编译和 Vite 开发服务器）
npm run dev
# 在另一个终端中启动 Electron
npm start
```

### 打包

发布版本由 GitHub Actions 统一打包（同时产出 Windows / macOS arm64 / macOS Intel 三个安装包）：

1. 在 `package.json` 中升级 `version`
2. 推送到 `main` 分支
3. 在仓库 **Actions → Build & Release → Run workflow** 手动触发

> 本地也可单独打包当前平台：`npm run package`（Windows）/ `npm run package:mac`（macOS Apple Silicon）。
> 注意：本地 macOS 打包只能产出与本机架构一致的包；跨架构（如在 Apple Silicon 上打 Intel 包）需通过 CI。

### 项目结构

```
TokenWave/
├── src/
│   ├── main/                       # Electron 主进程
│   │   ├── index.ts                # 主入口，窗口创建和 IPC 注册
│   │   ├── tool-manager.ts         # 工具发现、启动配置和更新管理
│   │   ├── pty-manager.ts          # PTY 终端会话管理（node-pty）
│   │   ├── config-store.ts         # 配置存储与 API Key 加密
│   │   ├── auth-manager.ts         # TokenWave 账户登录
│   │   ├── key-provisioner.ts      # 一键开通 Claude / Codex 密钥
│   │   ├── account-manager.ts      # 余额、充值、使用记录
│   │   ├── image-generator.ts      # AI 生图（OpenAI 兼容 + Gemini 双引擎）
│   │   ├── mcp-manager.ts          # MCP 服务器管理（Claude .mcp.json / Codex config.toml）
│   │   ├── skills-manager.ts       # Claude Skills 管理（SKILL.md 增删改）
│   │   ├── local-config-importer.ts# 导入本机 ~/.claude、~/.codex 配置
│   │   ├── app-updater.ts          # 应用自更新与远程配置同步
│   │   ├── preload.ts              # IPC 桥接，暴露安全 API 给渲染进程
│   │   └── process-env.ts          # 环境变量白名单过滤
│   └── renderer/                   # 渲染进程（前端 UI）
│       ├── index.html              # 主页面
│       ├── app.js                  # 应用逻辑
│       ├── editor.js               # CodeMirror 文件编辑器封装
│       ├── image-gen.js            # 生图面板 UI
│       ├── extensions.js           # 扩展管理面板（MCP & Skills）UI
│       └── styles/global.css       # 全局样式
├── scripts/
│   ├── bundle-tools.mjs            # 打包工具脚本（下载 CLI 和运行时）
│   └── build*.bat / build.ps1      # 构建脚本
├── resources/
│   ├── bundled-tools/              # 内置的 CLI 工具和运行时
│   ├── dmg/                        # macOS dmg 内附说明文件
│   ├── icon.ico                    # Windows 应用图标
│   └── icon.icns                   # macOS 应用图标
├── .github/workflows/release.yml   # 三平台 CI 打包（Win / macOS arm64 / macOS x64）
├── vite.config.ts                  # Vite 构建配置
└── package.json                    # 项目配置
```
---

## 📝 许可证

[MIT License](LICENSE)

---

<p align="center">
  <sub>Made with ⚡ by TokenWave</sub>
</p>
