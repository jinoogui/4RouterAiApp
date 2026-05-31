import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyManager } from './pty-manager';
import { ToolManager } from './tool-manager';
import { ConfigStore } from './config-store';
import { AppUpdater } from './app-updater';
import { AuthManager } from './auth-manager';
import { KeyProvisioner } from './key-provisioner';
import { LocalConfigImporter } from './local-config-importer';
import { AccountManager } from './account-manager';
import { SessionStore } from './session-store';
import { ImageGenerator } from './image-generator';

let mainWindow: BrowserWindow | null = null;
let ptyManager: PtyManager;
let toolManager: ToolManager;
let configStore: ConfigStore;
let appUpdater: AppUpdater;
let authManager: AuthManager;
let keyProvisioner: KeyProvisioner;
let localConfigImporter: LocalConfigImporter;
let accountManager: AccountManager;
let sessionStore: SessionStore;
let imageGenerator: ImageGenerator;

function getResourcesPath(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'bundled-tools');
    }
    return path.join(__dirname, '..', '..', 'resources', 'bundled-tools');
}

// Validate a user-supplied file/folder name: reject empty, path separators,
// traversal, and characters illegal on Windows. Returns the trimmed name or
// null when invalid. Keeps create/rename confined to a single directory level.
function sanitizeEntryName(name: string): string | null {
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return null;
    if (/[\\/]/.test(trimmed)) return null;
    if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) return null;
    if (trimmed.length > 255) return null;
    return trimmed;
}

function createWindow(): void {
    const isMac = process.platform === 'darwin';
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'TokenWave',
        backgroundColor: '#0d1117',
        // macOS: keep native traffic-light buttons; the titlebar area becomes
        // a draggable transparent strip that we render our logo into.
        // Windows/Linux: fully custom titlebar with overlay-rendered controls.
        frame: isMac ? undefined : false,
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        ...(isMac ? {} : {
            titleBarOverlay: {
                color: '#0d1117',
                symbolColor: '#c9d1d9',
                height: 38,
            },
        }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false, // Required for node-pty IPC
        },
        // Per-platform window icon (the .ico is Windows-only; .icns is for
        // packaged macOS .app bundles where Electron picks it up via
        // electron-builder, so the BrowserWindow icon field there is ignored).
        icon: isMac
            ? path.join(__dirname, '..', '..', 'resources', 'icon.icns')
            : path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    });

    // Dock icon for macOS development mode. In a packaged .app, Electron uses
    // the icon set in Info.plist via electron-builder, so this is a no-op.
    // Use the PNG directly here — Electron's nativeImage rejects some valid
    // .icns files in dev, while PNG works on every platform.
    if (isMac && app.dock) {
        try {
            app.dock.setIcon(path.join(__dirname, '..', '..', 'resources', 'icon.png'));
        } catch (err) {
            console.warn('[index] Failed to set dock icon:', err);
        }
    }

    // Load renderer
    if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Open links in default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

function setupIPC(): void {
    // ===== Tool Management =====
    ipcMain.handle('tools:list', () => {
        return toolManager.listTools();
    });

    ipcMain.handle('tools:get-status', (_event, toolId: string) => {
        return toolManager.getToolStatus(toolId);
    });

    ipcMain.handle('tools:update', async (_event, toolId: string) => {
        return toolManager.updateTool(toolId);
    });

    ipcMain.handle('tools:get-launch-preview', (_event, toolId: string) => {
        return toolManager.getLaunchConfig(toolId);
    });

    ipcMain.handle('tools:check-update', async (_event, toolId: string) => {
        return toolManager.checkUpdate(toolId);
    });

    // ===== PTY Management =====
    ipcMain.handle('pty:create', (_event, toolId: string, cwd?: string, resumeId?: string) => {
        const sessionId = ptyManager.createSession(toolId, cwd, resumeId);
        return sessionId;
    });

    ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
        ptyManager.write(sessionId, data);
    });

    ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
        ptyManager.resize(sessionId, cols, rows);
    });

    ipcMain.handle('pty:destroy', (_event, sessionId: string) => {
        ptyManager.destroySession(sessionId);
    });

    // ===== Session History =====
    ipcMain.handle('sessions:list', async () => {
        try {
            const data = await sessionStore.listSessions();
            return { success: true, data };
        } catch (err) {
            return { success: false, error: String(err) };
        }
    });

    // ===== Window Titlebar Overlay =====
    // setTitleBarOverlay only exists on Windows/Linux. On macOS the native
    // traffic-light buttons handle theming themselves.
    ipcMain.handle('window:set-titlebar-overlay', (_event, colors: { color: string; symbolColor: string }) => {
        if (!mainWindow || process.platform === 'darwin') return;
        if (typeof mainWindow.setTitleBarOverlay !== 'function') return;
        mainWindow.setTitleBarOverlay({
            color: colors.color,
            symbolColor: colors.symbolColor,
            height: 38,
        });
    });

    // ===== Config Management =====
    ipcMain.handle('config:get', (_event, key: string) => {
        return configStore.get(key);
    });

    ipcMain.handle('config:set', (_event, key: string, value: any) => {
        configStore.set(key, value);
    });

    ipcMain.handle('config:get-api-key', (_event, provider: string) => {
        return configStore.getApiKey(provider);
    });

    ipcMain.handle('config:set-api-key', (_event, provider: string, key: string) => {
        configStore.setApiKey(provider, key);
    });

    ipcMain.handle('config:has-api-key', (_event, provider: string) => {
        return configStore.hasApiKey(provider);
    });

    ipcMain.handle('config:get-base-url', (_event, provider: string) => {
        return configStore.getBaseUrl(provider);
    });

    ipcMain.handle('config:set-base-url', (_event, provider: string, url: string) => {
        configStore.setBaseUrl(provider, url);
    });

    ipcMain.handle('config:get-model', (_event, provider: string) => {
        return configStore.getModel(provider);
    });

    ipcMain.handle('config:set-model', (_event, provider: string, model: string) => {
        configStore.setModel(provider, model);
    });

    // ===== Window Controls =====
    ipcMain.on('window:minimize', () => mainWindow?.minimize());
    ipcMain.on('window:maximize', () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow?.maximize();
        }
    });
    ipcMain.on('window:close', () => mainWindow?.close());

    // ===== App Info =====
    ipcMain.handle('app:get-version', () => app.getVersion());
    // Encryption is always available: ConfigStore uses a local Node-crypto
    // derived key (no OS keychain), so this never prompts.
    ipcMain.handle('app:is-encryption-available', () => true);

    // ===== App Update =====
    ipcMain.handle('app:check-app-update', async () => {
        return appUpdater.checkForUpdate();
    });

    ipcMain.handle('app:download-update', async (_event, downloadUrl: string) => {
        return appUpdater.downloadUpdate(downloadUrl);
    });

    // ===== Remote Config Sync =====
    ipcMain.handle('app:check-remote-config', async () => {
        return appUpdater.checkRemoteConfig();
    });

    ipcMain.handle('app:apply-remote-config', async (_event, remoteConfig: Record<string, any>) => {
        appUpdater.applyRemoteConfig(remoteConfig);
        return { success: true };
    });

    // ===== Auth (Module 1) =====
    ipcMain.handle('auth:login-webview', async () => {
        if (!mainWindow) return { success: false, error: '窗口未就绪' };
        return authManager.loginViaWebView(mainWindow);
    });

    // In-app username/password login & registration (no WebView).
    ipcMain.handle('auth:login-credentials', (_e, username: string, password: string) =>
        authManager.loginWithCredentials(username, password));
    ipcMain.handle('auth:register', (_e, username: string, password: string) =>
        authManager.register(username, password));

    ipcMain.handle('auth:is-logged-in', () => {
        return authManager.isLoggedIn();
    });

    ipcMain.handle('auth:logout', () => {
        authManager.logout();
    });

    // ===== Local Config Import =====
    // Reads ~/.claude/settings.json and ~/.codex/{config.toml,auth.json}
    // and copies them into TokenWave's private claude-home/codex-home so
    // bundled tools inherit the user's existing hooks, MCP servers, and
    // API credentials without manual entry.
    ipcMain.handle('local-config:scan', () => {
        return localConfigImporter.scan();
    });
    ipcMain.handle('local-config:apply', async (_event, scan: any) => {
        return localConfigImporter.apply(scan);
    });

    // ===== Key Provisioning (Module 2) =====
    ipcMain.handle('provision:create-keys', async () => {
        const accessToken = authManager.getAccessToken();
        const userId = authManager.getUserId();
        if (!accessToken || !userId) return { success: false, error: '未登录 TokenWave' };

        const result = await keyProvisioner.provisionKeys(accessToken, userId);
        if (result.success) {
            // Auto-configure API keys and base URLs in ConfigStore
            if (result.claudeKey) {
                configStore.setApiKey('anthropic', result.claudeKey);
                configStore.setBaseUrl('anthropic', 'https://api.dshub.top');
            }
            if (result.codexKey) {
                configStore.setApiKey('openai', result.codexKey);
                configStore.setBaseUrl('openai', 'https://api.dshub.top/v1');
            }
        }
        return result;
    });

    // ===== Account (Module 3): balance, usage logs, top-up =====
    ipcMain.handle('account:get-balance', async () => {
        const accessToken = authManager.getAccessToken();
        const userId = authManager.getUserId();
        if (!accessToken || !userId) return { success: false, error: '未登录 TokenWave' };
        return accountManager.getBalance(accessToken, userId);
    });

    ipcMain.handle('account:get-logs', async (_event, page: number, pageSize: number) => {
        const accessToken = authManager.getAccessToken();
        const userId = authManager.getUserId();
        if (!accessToken || !userId) return { success: false, error: '未登录 TokenWave' };
        return accountManager.getLogs(accessToken, userId, page || 1, pageSize || 20);
    });

    ipcMain.handle('account:get-price', async (_event, amount: number, channel: string) => {
        const accessToken = authManager.getAccessToken();
        const userId = authManager.getUserId();
        if (!accessToken || !userId) return { success: false, error: '未登录 TokenWave' };
        return accountManager.getTopupPrice(accessToken, userId, amount, channel || 'alipay');
    });

    ipcMain.handle('account:create-payment', async (_event, amount: number, method: string) => {
        const accessToken = authManager.getAccessToken();
        const userId = authManager.getUserId();
        if (!accessToken || !userId) return { success: false, error: '未登录 TokenWave' };
        // Returns order_no + qrContent so the renderer can show an in-app QR;
        // it no longer auto-opens the browser.
        return accountManager.createPayment(accessToken, userId, amount, method || 'alipay');
    });

    ipcMain.handle('account:query-order', async (_event, orderNo: string) => {
        if (!orderNo) return { paid: false, error: '缺少订单号' };
        return accountManager.queryOrder(orderNo);
    });

    // Open the hosted checkout page in the system browser (manual fallback).
    ipcMain.handle('account:open-paylink', async (_event, payLink: string) => {
        if (payLink && /^https?:\/\//.test(payLink)) {
            shell.openExternal(payLink);
            return { success: true };
        }
        return { success: false, error: '无效的支付链接' };
    });

    // ===== Dialog =====
    ipcMain.handle('dialog:select-directory', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    // ===== File System =====
    ipcMain.handle('fs:read-dir', async (_event, dirPath: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: nodePath.join(dirPath, e.name),
                    isDirectory: e.isDirectory(),
                }))
                .sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        } catch {
            return [];
        }
    });

    // Read a text file for the in-app editor. Guards against oversized files
    // and binary content (NUL byte sniff) so the editor never tries to load a
    // multi-MB blob or render garbage.
    ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
        const fs = require('fs') as typeof import('fs');
        try {
            const stat = fs.statSync(filePath);
            const MAX = 5 * 1024 * 1024; // 5 MB
            if (stat.size > MAX) {
                return { success: false, error: '文件过大（超过 5MB），无法在编辑器中打开' };
            }
            const buf = fs.readFileSync(filePath);
            // Binary sniff: a NUL in the first 8KB strongly implies non-text.
            const probe = buf.subarray(0, Math.min(buf.length, 8192));
            if (probe.includes(0)) {
                return { success: false, error: '二进制文件，无法以文本方式打开' };
            }
            return { success: true, content: buf.toString('utf8') };
        } catch (err: any) {
            return { success: false, error: err?.message || '读取文件失败' };
        }
    });

    // Write text content back to a file from the in-app editor.
    ipcMain.handle('fs:write-file', async (_event, filePath: string, content: string) => {
        const fs = require('fs') as typeof import('fs');
        try {
            fs.writeFileSync(filePath, content, 'utf8');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '保存文件失败' };
        }
    });

    // Create an empty file. Fails if the target already exists so we never
    // silently clobber existing content.
    ipcMain.handle('fs:create-file', async (_event, dirPath: string, name: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        const safe = sanitizeEntryName(name);
        if (!safe) return { success: false, error: '名称无效' };
        const target = nodePath.join(dirPath, safe);
        try {
            if (fs.existsSync(target)) return { success: false, error: '同名文件已存在' };
            fs.writeFileSync(target, '', { flag: 'wx' });
            return { success: true, path: target };
        } catch (err: any) {
            return { success: false, error: err?.message || '创建文件失败' };
        }
    });

    // Create a directory (non-recursive); fails on existing name.
    ipcMain.handle('fs:create-dir', async (_event, dirPath: string, name: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        const safe = sanitizeEntryName(name);
        if (!safe) return { success: false, error: '名称无效' };
        const target = nodePath.join(dirPath, safe);
        try {
            if (fs.existsSync(target)) return { success: false, error: '同名文件夹已存在' };
            fs.mkdirSync(target);
            return { success: true, path: target };
        } catch (err: any) {
            return { success: false, error: err?.message || '创建文件夹失败' };
        }
    });

    // Rename within the same parent directory. The new name is a leaf name,
    // not a path, so renaming can't move the entry elsewhere.
    ipcMain.handle('fs:rename', async (_event, oldPath: string, newName: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        const safe = sanitizeEntryName(newName);
        if (!safe) return { success: false, error: '名称无效' };
        const target = nodePath.join(nodePath.dirname(oldPath), safe);
        try {
            if (target === oldPath) return { success: true, path: target };
            if (fs.existsSync(target)) return { success: false, error: '同名项已存在' };
            fs.renameSync(oldPath, target);
            return { success: true, path: target };
        } catch (err: any) {
            return { success: false, error: err?.message || '重命名失败' };
        }
    });

    // Delete a file or directory (recursive for dirs).
    ipcMain.handle('fs:delete', async (_event, targetPath: string) => {
        const fs = require('fs') as typeof import('fs');
        try {
            fs.rmSync(targetPath, { recursive: true, force: true });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '删除失败' };
        }
    });

    // Move a file/dir into destDir. Rejects moving a directory into itself or
    // its own descendant (which would corrupt the tree), and name collisions.
    ipcMain.handle('fs:move', async (_event, srcPath: string, destDir: string) => {
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        try {
            const name = nodePath.basename(srcPath);
            const target = nodePath.join(destDir, name);
            const srcResolved = nodePath.resolve(srcPath);
            const destResolved = nodePath.resolve(destDir);
            if (srcResolved === destResolved) return { success: false, error: '源和目标相同' };
            if (nodePath.dirname(srcResolved) === destResolved) {
                return { success: false, error: '已在该文件夹中' };
            }
            // Block moving a folder into its own subtree.
            if ((destResolved + nodePath.sep).startsWith(srcResolved + nodePath.sep)) {
                return { success: false, error: '不能移动到自身的子目录' };
            }
            if (fs.existsSync(target)) return { success: false, error: '目标文件夹中已存在同名项' };
            fs.renameSync(srcPath, target);
            return { success: true, path: target };
        } catch (err: any) {
            return { success: false, error: err?.message || '移动失败' };
        }
    });

    // ===== Clipboard =====
    // Read an image from the OS clipboard, write it to a temp .png file,
    // and return the path. Returns null when the clipboard has no image.
    ipcMain.handle('clipboard:read-image', async () => {
        try {
            const image = clipboard.readImage();
            if (image.isEmpty()) return null;
            const buf = image.toPNG();
            if (!buf || buf.length === 0) return null;

            const dir = path.join(os.tmpdir(), '4routerai-paste');
            fs.mkdirSync(dir, { recursive: true });
            const filename = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
            const filePath = path.join(dir, filename);
            fs.writeFileSync(filePath, buf);
            return filePath;
        } catch (err) {
            console.error('[clipboard:read-image] failed:', err);
            return null;
        }
    });

    // Save bytes from a dropped image into the same temp directory as
    // pasted images, then return the path. Mirrors the paste flow so
    // the renderer can feed both into Claude Code's bracketed-paste
    // attachment handler.
    ipcMain.handle('clipboard:save-dropped-image', async (_event, payload: { bytes: ArrayBuffer; ext: string }) => {
        try {
            const buf = Buffer.from(payload.bytes);
            if (buf.length === 0) return null;
            const safeExt = (payload.ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';

            const dir = path.join(os.tmpdir(), '4routerai-paste');
            fs.mkdirSync(dir, { recursive: true });
            const filename = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
            const filePath = path.join(dir, filename);
            fs.writeFileSync(filePath, buf);
            return filePath;
        } catch (err) {
            console.error('[clipboard:save-dropped-image] failed:', err);
            return null;
        }
    });

    // Open the Codex-generated-images folder for the current project.
    // Creates it if needed so the user always lands in a real folder.
    ipcMain.handle('tools:open-generated-images', async () => {
        try {
            const cwd = (configStore.get('defaultCwd') as string) || '';
            const dir = toolManager.getGeneratedImagesDir(cwd || null);
            fs.mkdirSync(dir, { recursive: true });
            await shell.openPath(dir);
            return { success: true, path: dir };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ===== Image Generation =====
    // Text-to-image and image-to-image via the OpenAI-compatible gateway,
    // reusing the provisioned `openai` key. The key never leaves the main
    // process. opts: { prompt, model, size?, n?, quality?, imagePath? }.
    //
    // Generated images are auto-persisted to generated_images so they survive
    // restarts; the renderer loads them back as a gallery via image:history.

    // Write one base64 data URL into generated_images, return its file path.
    // Path is derived server-side so writes stay confined to that folder.
    const persistImageDataUrl = (dataUrl: string): string | null => {
        const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
        if (!m) return null;
        const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const buf = Buffer.from(m[2], 'base64');
        const cwd = (configStore.get('defaultCwd') as string) || '';
        const dir = toolManager.getGeneratedImagesDir(cwd || null);
        fs.mkdirSync(dir, { recursive: true });
        const filename = `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, buf);
        return filePath;
    };

    // Auto-save every freshly generated image, attaching its on-disk path so
    // the renderer can reveal it. A write failure must not drop the image.
    const persistResult = (result: any) => {
        if (!result?.success || !Array.isArray(result.images)) return result;
        result.paths = result.images.map((dataUrl: string) => {
            try {
                return persistImageDataUrl(dataUrl);
            } catch {
                return null;
            }
        });
        return result;
    };

    ipcMain.handle('image:generate', async (_event, opts: any) => {
        const key = configStore.getApiKey('openai');
        if (!key) return { success: false, error: '未配置生图 API Key，请先登录 TokenWave 或在设置中填写 OpenAI Key' };
        return persistResult(await imageGenerator.generate(key, opts || {}));
    });

    ipcMain.handle('image:edit', async (_event, opts: any) => {
        const key = configStore.getApiKey('openai');
        if (!key) return { success: false, error: '未配置生图 API Key，请先登录 TokenWave 或在设置中填写 OpenAI Key' };
        return persistResult(await imageGenerator.edit(key, opts || {}));
    });

    // Load previously generated images (newest first) as a gallery. Returns
    // file:// URLs the renderer can render directly under the relaxed CSP.
    ipcMain.handle('image:history', async () => {
        try {
            const cwd = (configStore.get('defaultCwd') as string) || '';
            const dir = toolManager.getGeneratedImagesDir(cwd || null);
            if (!fs.existsSync(dir)) return { success: true, items: [] };
            const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
            const items = fs.readdirSync(dir)
                .filter((f) => exts.has(path.extname(f).toLowerCase()))
                .map((f) => {
                    const full = path.join(dir, f);
                    return { path: full, url: 'file://' + full, mtime: fs.statSync(full).mtimeMs };
                })
                .sort((a, b) => b.mtime - a.mtime);
            return { success: true, items };
        } catch (err: any) {
            return { success: false, error: err?.message || '读取历史失败', items: [] };
        }
    });

    // Reveal a single generated image in the OS file manager.
    ipcMain.handle('image:reveal', async (_event, filePath: string) => {
        try {
            const cwd = (configStore.get('defaultCwd') as string) || '';
            const dir = toolManager.getGeneratedImagesDir(cwd || null);
            // Only reveal paths inside the managed folder.
            if (!filePath || !path.resolve(filePath).startsWith(path.resolve(dir))) {
                return { success: false, error: '路径不在生成目录内' };
            }
            shell.showItemInFolder(filePath);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '打开失败' };
        }
    });

    // Let the user pick a local source image for image-to-image. Returns the
    // chosen path, or null when canceled.
    ipcMain.handle('image:pick-source', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        });
        return result.canceled ? null : result.filePaths[0];
    });
}

app.whenReady().then(() => {
    const bundledToolsPath = getResourcesPath();

    configStore = new ConfigStore();
    toolManager = new ToolManager(bundledToolsPath, configStore);
    ptyManager = new PtyManager(toolManager);
    appUpdater = new AppUpdater(configStore);
    authManager = new AuthManager(configStore);
    keyProvisioner = new KeyProvisioner();
    localConfigImporter = new LocalConfigImporter(configStore, toolManager.getAppDataDir());
    accountManager = new AccountManager();
    sessionStore = new SessionStore(toolManager);
    imageGenerator = new ImageGenerator(configStore);

    // Forward PTY data to renderer
    ptyManager.onData((sessionId: string, data: string) => {
        mainWindow?.webContents.send('pty:data', sessionId, data);
    });

    ptyManager.onExit((sessionId: string, exitCode: number) => {
        mainWindow?.webContents.send('pty:exit', sessionId, exitCode);
    });

    setupIPC();
    createWindow();

    // Set mainWindow reference for app updater progress events
    appUpdater.setMainWindow(mainWindow);
});

app.on('window-all-closed', () => {
    ptyManager?.destroyAll();
    app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
