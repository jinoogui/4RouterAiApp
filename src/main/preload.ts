import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe API to the renderer process via contextBridge
contextBridge.exposeInMainWorld('routerAi', {
    // Read-only host info — used for OS-conditional UI (e.g. hide custom
    // titlebar controls on macOS where the OS draws traffic-light buttons).
    platform: process.platform,
    // ===== Tool Management =====
    tools: {
        list: () => ipcRenderer.invoke('tools:list'),
        getStatus: (toolId: string) => ipcRenderer.invoke('tools:get-status', toolId),
        update: (toolId: string) => ipcRenderer.invoke('tools:update', toolId),
        getLaunchPreview: (toolId: string) => ipcRenderer.invoke('tools:get-launch-preview', toolId),
        checkUpdate: (toolId: string) => ipcRenderer.invoke('tools:check-update', toolId),
        openGeneratedImages: () =>
            ipcRenderer.invoke('tools:open-generated-images') as Promise<{ success: boolean; path?: string; error?: string }>,
    },

    // ===== Terminal (PTY) =====
    pty: {
        create: (toolId: string, cwd?: string, resumeId?: string) =>
            ipcRenderer.invoke('pty:create', toolId, cwd, resumeId),
        write: (sessionId: string, data: string) => ipcRenderer.send('pty:write', sessionId, data),
        resize: (sessionId: string, cols: number, rows: number) =>
            ipcRenderer.send('pty:resize', sessionId, cols, rows),
        destroy: (sessionId: string) => ipcRenderer.invoke('pty:destroy', sessionId),
        onData: (callback: (sessionId: string, data: string) => void) => {
            const listener = (_event: any, sessionId: string, data: string) => callback(sessionId, data);
            ipcRenderer.on('pty:data', listener);
            return () => ipcRenderer.removeListener('pty:data', listener);
        },
        onExit: (callback: (sessionId: string, exitCode: number) => void) => {
            const listener = (_event: any, sessionId: string, exitCode: number) =>
                callback(sessionId, exitCode);
            ipcRenderer.on('pty:exit', listener);
            return () => ipcRenderer.removeListener('pty:exit', listener);
        },
    },

    // ===== Session History =====
    sessions: {
        list: () =>
            ipcRenderer.invoke('sessions:list') as Promise<{
                success: boolean;
                data?: Array<{
                    id: string;
                    tool: 'claude-code' | 'codex';
                    title: string;
                    cwd: string;
                    updatedAt: number;
                }>;
                error?: string;
            }>,
    },

    // ===== Config =====
    config: {
        get: (key: string) => ipcRenderer.invoke('config:get', key),
        set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
        getApiKey: (provider: string) => ipcRenderer.invoke('config:get-api-key', provider),
        setApiKey: (provider: string, key: string) =>
            ipcRenderer.invoke('config:set-api-key', provider, key),
        hasApiKey: (provider: string) => ipcRenderer.invoke('config:has-api-key', provider),
        getBaseUrl: (provider: string) => ipcRenderer.invoke('config:get-base-url', provider),
        setBaseUrl: (provider: string, url: string) =>
            ipcRenderer.invoke('config:set-base-url', provider, url),
        getModel: (provider: string) => ipcRenderer.invoke('config:get-model', provider),
        setModel: (provider: string, model: string) =>
            ipcRenderer.invoke('config:set-model', provider, model),
    },

    // ===== Window Controls =====
    window: {
        minimize: () => ipcRenderer.send('window:minimize'),
        maximize: () => ipcRenderer.send('window:maximize'),
        close: () => ipcRenderer.send('window:close'),
        setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
            ipcRenderer.invoke('window:set-titlebar-overlay', colors),
    },

    // ===== App =====
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version'),
        isEncryptionAvailable: () => ipcRenderer.invoke('app:is-encryption-available'),
        checkAppUpdate: () => ipcRenderer.invoke('app:check-app-update'),
        downloadUpdate: (url: string) => ipcRenderer.invoke('app:download-update', url),
        onUpdateProgress: (callback: (percent: number, message?: string) => void) => {
            const listener = (_event: any, percent: number, message?: string) => callback(percent, message);
            ipcRenderer.on('app-update:progress', listener);
            return () => ipcRenderer.removeListener('app-update:progress', listener);
        },
        checkRemoteConfig: () => ipcRenderer.invoke('app:check-remote-config'),
        applyRemoteConfig: (config: Record<string, any>) => ipcRenderer.invoke('app:apply-remote-config', config),
    },

    // ===== Аuth =====
    auth: {
        loginWebView: () => ipcRenderer.invoke('auth:login-webview'),
        login: (username: string, password: string) =>
            ipcRenderer.invoke('auth:login-credentials', username, password),
        register: (username: string, password: string) =>
            ipcRenderer.invoke('auth:register', username, password),
        isLoggedIn: () => ipcRenderer.invoke('auth:is-logged-in'),
        logout: () => ipcRenderer.invoke('auth:logout'),
    },

    // ===== Key Provisioning =====
    provision: {
        createKeys: () => ipcRenderer.invoke('provision:create-keys'),
    },

    // ===== Image Generation =====
    image: {
        generate: (opts: { prompt: string; model: string; size?: string; n?: number; quality?: string }) =>
            ipcRenderer.invoke('image:generate', opts) as Promise<{ success: boolean; images?: string[]; paths?: (string | null)[]; error?: string }>,
        edit: (opts: { prompt: string; model: string; size?: string; n?: number; imagePath: string }) =>
            ipcRenderer.invoke('image:edit', opts) as Promise<{ success: boolean; images?: string[]; paths?: (string | null)[]; error?: string }>,
        history: () =>
            ipcRenderer.invoke('image:history') as Promise<{ success: boolean; items: { path: string; url: string; mtime: number }[]; error?: string }>,
        reveal: (filePath: string) =>
            ipcRenderer.invoke('image:reveal', filePath) as Promise<{ success: boolean; error?: string }>,
        pickSource: () => ipcRenderer.invoke('image:pick-source') as Promise<string | null>,
    },

    // ===== MCP servers (Claude Code + Codex) =====
    mcp: {
        list: () => ipcRenderer.invoke('mcp:list'),
        add: (server: any) => ipcRenderer.invoke('mcp:add', server),
        update: (oldName: string, server: any) => ipcRenderer.invoke('mcp:update', oldName, server),
        remove: (name: string) => ipcRenderer.invoke('mcp:remove', name),
        toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle', name, enabled),
        search: (query: string) => ipcRenderer.invoke('mcp:search', query),
        install: (payload: any) => ipcRenderer.invoke('mcp:install', payload),
    },

    // ===== Skills (Claude Code only) =====
    skills: {
        list: () => ipcRenderer.invoke('skills:list'),
        create: (name: string, description: string) => ipcRenderer.invoke('skills:create', name, description),
        read: (name: string) => ipcRenderer.invoke('skills:read', name),
        update: (name: string, content: string) => ipcRenderer.invoke('skills:update', name, content),
        remove: (name: string) => ipcRenderer.invoke('skills:remove', name),
        toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('skills:toggle', name, enabled),
        search: (repoOverride?: string) => ipcRenderer.invoke('skills:search', repoOverride),
        install: (payload: any) => ipcRenderer.invoke('skills:install', payload),
        installUrl: (payload: any) => ipcRenderer.invoke('skills:install-url', payload),
    },

    // ===== Local Config Import =====
    localConfig: {
        scan: () => ipcRenderer.invoke('local-config:scan'),
        apply: (scan: any) => ipcRenderer.invoke('local-config:apply', scan),
    },

    // ===== Account: balance, usage logs, top-up =====
    account: {
        getBalance: () => ipcRenderer.invoke('account:get-balance'),
        getLogs: (page: number, pageSize: number) =>
            ipcRenderer.invoke('account:get-logs', page, pageSize),
        getPrice: (amount: number, channel: string) => ipcRenderer.invoke('account:get-price', amount, channel),
        createPayment: (amount: number, method: string) =>
            ipcRenderer.invoke('account:create-payment', amount, method),
        queryOrder: (orderNo: string) => ipcRenderer.invoke('account:query-order', orderNo),
        openPayLink: (payLink: string) => ipcRenderer.invoke('account:open-paylink', payLink),
    },

    // ===== Dialog =====
    dialog: {
        selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
    },

    // ===== File System =====
    fs: {
        readDir: (dirPath: string) => ipcRenderer.invoke('fs:read-dir', dirPath),
        readFile: (filePath: string) =>
            ipcRenderer.invoke('fs:read-file', filePath) as Promise<{ success: boolean; content?: string; error?: string }>,
        writeFile: (filePath: string, content: string) =>
            ipcRenderer.invoke('fs:write-file', filePath, content) as Promise<{ success: boolean; error?: string }>,
        createFile: (dirPath: string, name: string) =>
            ipcRenderer.invoke('fs:create-file', dirPath, name) as Promise<{ success: boolean; path?: string; error?: string }>,
        createDir: (dirPath: string, name: string) =>
            ipcRenderer.invoke('fs:create-dir', dirPath, name) as Promise<{ success: boolean; path?: string; error?: string }>,
        rename: (oldPath: string, newName: string) =>
            ipcRenderer.invoke('fs:rename', oldPath, newName) as Promise<{ success: boolean; path?: string; error?: string }>,
        delete: (targetPath: string) =>
            ipcRenderer.invoke('fs:delete', targetPath) as Promise<{ success: boolean; error?: string }>,
        move: (srcPath: string, destDir: string) =>
            ipcRenderer.invoke('fs:move', srcPath, destDir) as Promise<{ success: boolean; path?: string; error?: string }>,
    },

    // ===== Clipboard =====
    clipboard: {
        // Returns a temp file path for an image in the clipboard, or null.
        readImage: () => ipcRenderer.invoke('clipboard:read-image') as Promise<string | null>,
        // Persists a dropped image's bytes to a temp file and returns its path.
        // The renderer reads File bytes via FileReader; the main process owns the FS write
        // so the path is reachable from the spawned CLI processes.
        saveDroppedImage: (bytes: ArrayBuffer, ext: string) =>
            ipcRenderer.invoke('clipboard:save-dropped-image', { bytes, ext }) as Promise<string | null>,
    },
});
