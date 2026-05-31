import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import QRCode from 'qrcode';
import { createEditor } from './editor.js';
import { createImagePanel } from './image-gen.js';

// ============================================================
// 4RouterAi — Main Renderer Application
// ============================================================

/** @type {typeof window.routerAi} */
const api = /** @type {any} */ (window).routerAi;

// ===== State =====
const state = {
    tabs: /** @type {TabState[]} */ ([]),
    activeTabId: /** @type {string|null} */ (null),
    currentCwd: '',
    workingDirs: /** @type {string[]} */ ([]),
    tabCounter: 0,
};

/**
 * @typedef {Object} TabState
 * @property {string} id
 * @property {'terminal'|'editor'|'image'} kind
 * @property {string} toolId
 * @property {string} toolName
 * @property {string} toolIcon
 * @property {string} [sessionId]
 * @property {Terminal} [terminal]
 * @property {FitAddon} [fitAddon]
 * @property {import('@codemirror/view').EditorView} [editor]
 * @property {{ destroy: () => void }} [panel]
 * @property {string} [filePath]
 * @property {boolean} [dirty]
 * @property {HTMLElement} wrapper
 * @property {HTMLElement} tabElement
 * @property {string} cwd
 */

// ===== DOM References =====
const $ = (/** @type {string} */ sel) => document.querySelector(sel);
const welcomeScreen = /** @type {HTMLElement} */ ($('#welcome-screen'));
const appScreen = /** @type {HTMLElement} */ ($('#app-screen'));
const tabBar = /** @type {HTMLElement} */ ($('#tab-bar'));
const tabBarEmpty = /** @type {HTMLElement} */ ($('#tab-bar-empty'));const terminalContainer = /** @type {HTMLElement} */ ($('#terminal-container'));
const emptyState = /** @type {HTMLElement} */ ($('#empty-state'));
const settingsModal = /** @type {HTMLElement} */ ($('#settings-modal'));
const cwdList = /** @type {HTMLElement} */ ($('#cwd-list'));
const fileExplorer = /** @type {HTMLElement} */ ($('#file-explorer'));
const fileTree = /** @type {HTMLElement} */ ($('#file-tree'));
const explorerPath = /** @type {HTMLElement} */ ($('#explorer-path'));

function refitTerminal(/** @type {TabState} */ tab, /** @type {{ focus?: boolean }} */ options = {}) {
    const runFit = () => {
        if (!state.tabs.includes(tab) || tab.wrapper.classList.contains('hidden')) return;
        tab.fitAddon.fit();
        api.pty.resize(tab.sessionId, tab.terminal.cols, tab.terminal.rows);
        if (options.focus) tab.terminal.focus();
    };

    requestAnimationFrame(() => {
        runFit();
        requestAnimationFrame(runFit);
        setTimeout(runFit, 120);
    });

    if (document.fonts?.ready) {
        document.fonts.ready.then(() => {
            runFit();
        }).catch(() => { /* ignore */ });
    }
}

// ===== Initialization =====
async function init() {
    setupWindowControls();
    setupToggleVisibility();
    setupGlobalDropGuard();
    await checkFirstLaunch();
    await applyTheme();
    setupWelcomeScreen();
    setupSidebar();
    setupSettings();
    setupAccount();
    setupPtyListeners();
    setupResize();
    setupFileExplorer();
    checkRemoteConfigOnStartup();
}

async function applyTheme(/** @type {string} */ themeOverride) {
    const theme = themeOverride || (await api.config.get('theme')) || 'fruit';
    document.documentElement.setAttribute('data-theme', theme);

    // Update native Windows titlebar button colors
    try {
        if (theme === 'light') {
            api.window.setTitleBarOverlay({ color: '#d0d7de', symbolColor: '#24292f' });
        } else if (theme === 'fruit') {
            api.window.setTitleBarOverlay({ color: '#f8dfbd', symbolColor: '#6d4624' });
        } else {
            api.window.setTitleBarOverlay({ color: '#0d1117', symbolColor: '#c9d1d9' });
        }
    } catch { /* ignore if not supported */ }

    const terminalTheme = getTerminalTheme(theme);
    for (const tab of state.tabs) {
        tab.terminal.options.theme = terminalTheme;
    }
}

function getTerminalTheme(/** @type {string} */ theme) {
    const darkTheme = {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: 'rgba(88,166,255,0.3)',
        black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d2c0', white: '#e6edf3',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
        brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    };
    const lightTheme = {
        background: '#f6f8fa',
        foreground: '#1f2328',
        cursor: '#0969da',
        cursorAccent: '#f6f8fa',
        selectionBackground: 'rgba(9,105,218,0.2)',
        black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
        blue: '#0969da', magenta: '#8250df', cyan: '#0a8a7a', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d5e00',
        brightBlue: '#0550ae', brightMagenta: '#6639ba', brightCyan: '#076c5e', brightWhite: '#8c959f',
    };
    const fruitTheme = {
        background: '#fff8ef',
        foreground: '#5f3d1f',
        cursor: '#f0902d',
        cursorAccent: '#fff8ef',
        selectionBackground: 'rgba(240,144,45,0.18)',
        black: '#6d4624', red: '#d96238', green: '#6a9d49', yellow: '#c98b2d',
        blue: '#d48b38', magenta: '#d97b58', cyan: '#83b96b', white: '#d6b28c',
        brightBlack: '#9b714b', brightRed: '#ee8963', brightGreen: '#89c36d', brightYellow: '#e6ad4c',
        brightBlue: '#efaa58', brightMagenta: '#efa07f', brightCyan: '#a4d58d', brightWhite: '#fff3e3',
    };

    if (theme === 'light') return lightTheme;
    if (theme === 'fruit') return fruitTheme;
    return darkTheme;
}

// ===== Window Controls =====
function setupWindowControls() {
    // Tag the body so platform-conditional CSS can hide our custom titlebar
    // controls on macOS (the OS draws native traffic-light buttons there).
    const platform = api.platform || (window.routerAi && window.routerAi.platform) || '';
    if (platform) document.body.classList.add(`platform-${platform}`);

    $('#btn-minimize')?.addEventListener('click', () => api.window.minimize());
    $('#btn-maximize')?.addEventListener('click', () => api.window.maximize());
    $('#btn-close')?.addEventListener('click', () => api.window.close());
}

// Suppress Electron's default file-drop navigation outside the terminal.
// Without this, dropping a file anywhere in the window replaces the page
// with file:// content. Terminal-wrappers re-enable drop via preventDefault
// in their own dragover/drop handlers.
function setupGlobalDropGuard() {
    window.addEventListener('dragover', (e) => { e.preventDefault(); }, false);
    window.addEventListener('drop', (e) => { e.preventDefault(); }, false);
}

// ===== Toggle Password Visibility =====
function setupToggleVisibility() {
    document.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('.btn-toggle-visibility');
        if (!btn) return;
        const targetId = btn.getAttribute('data-target');
        if (!targetId) return;
        const input = /** @type {HTMLInputElement} */ (document.getElementById(targetId));
        if (input) {
            input.type = input.type === 'password' ? 'text' : 'password';
        }
    });
}

// ===== First Launch Check =====
async function checkFirstLaunch() {
    const firstLaunch = await api.config.get('firstLaunch');
    const hasAnthropic = await api.config.hasApiKey('anthropic');
    const hasOpenai = await api.config.hasApiKey('openai');

    if (!firstLaunch && (hasAnthropic || hasOpenai)) {
        showAppScreen();
    } else {
        showWelcomeScreen();
    }

    // Load saved working directories + active selection.
    state.workingDirs = (await api.config.get('workingDirectories')) || [];
    const savedCwd = await api.config.get('defaultCwd');
    if (savedCwd) {
        state.currentCwd = savedCwd;
        if (!state.workingDirs.includes(savedCwd)) state.workingDirs.push(savedCwd);
    } else if (state.workingDirs.length) {
        state.currentCwd = state.workingDirs[0];
    }
    renderCwdList();
    if (state.currentCwd) loadFileTree(state.currentCwd);
}

function showWelcomeScreen() {
    welcomeScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
}

function showAppScreen() {
    welcomeScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    refreshSidebarAccount();
}

function shortenPath(/** @type {string} */ p) {
    if (p.length <= 30) return p;
    const parts = p.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return p;
    return parts[0] + '/.../' + parts.slice(-2).join('/');
}

// Split a path into { parent, tail }: tail is the last segment (shown in full,
// it's the directory name that matters), parent is everything before it (dimmed
// + truncated). Handles both / and \ separators and trailing slashes.
function splitPathTail(/** @type {string} */ p) {
    const norm = (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    if (idx < 0) return { parent: '', tail: norm };
    return { parent: norm.slice(0, idx + 1), tail: norm.slice(idx + 1) || norm };
}

// ===== Working Directory List =====

// Render the sidebar working-directory list. Each row highlights when it's the
// current selection (.active) and shows a dot when a tab is bound to it (.bound).
function renderCwdList() {
    if (!cwdList) return;
    cwdList.innerHTML = '';
    if (state.workingDirs.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'cwd-empty';
        hint.textContent = '点击 + 添加目录';
        cwdList.appendChild(hint);
        return;
    }
    const boundCwds = new Set(state.tabs.map((t) => t.cwd).filter(Boolean));
    for (const dir of state.workingDirs) {
        const { parent, tail } = splitPathTail(dir);
        const item = document.createElement('div');
        item.className = 'cwd-item';
        if (dir === state.currentCwd) item.classList.add('active');
        if (boundCwds.has(dir)) item.classList.add('bound');
        item.setAttribute('data-cwd', dir);
        item.title = dir;
        item.innerHTML =
            `<span class="cwd-item-label">` +
            (parent ? `<span class="cwd-item-parent">${escapeHtml(parent)}</span>` : '') +
            `<span class="cwd-item-tail">${escapeHtml(tail)}</span>` +
            `</span>` +
            `<span class="cwd-item-remove" title="移除">&times;</span>`;
        item.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */ (e.target)?.closest('.cwd-item-remove')) {
                removeCwd(dir);
            } else {
                selectCwd(dir);
            }
        });
        cwdList.appendChild(item);
    }
}

// Select a directory: make it the current cwd, load its file tree, and if a tab
// is already bound to it, activate that tab (bidirectional highlight).
function selectCwd(/** @type {string} */ dir) {
    state.currentCwd = dir;
    api.config.set('defaultCwd', dir);
    loadFileTree(dir);
    const bound = state.tabs.find((t) => t.cwd === dir);
    if (bound && bound.id !== state.activeTabId) {
        activateTab(bound.id); // activateTab re-renders the list
    } else {
        renderCwdList();
    }
    updateTabTints();
}

async function addCwd() {
    const dir = await api.dialog.selectDirectory();
    if (!dir) return;
    if (!state.workingDirs.includes(dir)) {
        state.workingDirs.push(dir);
        await api.config.set('workingDirectories', state.workingDirs);
    }
    selectCwd(dir);
}

// Remove a directory from the list. If it was the current selection, fall back
// to the active tab's cwd, then the first remaining dir, then nothing.
async function removeCwd(/** @type {string} */ dir) {
    state.workingDirs = state.workingDirs.filter((d) => d !== dir);
    await api.config.set('workingDirectories', state.workingDirs);
    if (state.currentCwd === dir) {
        const active = state.tabs.find((t) => t.id === state.activeTabId);
        const fallback =
            active && state.workingDirs.includes(active.cwd)
                ? active.cwd
                : state.workingDirs[0] || '';
        if (fallback) {
            selectCwd(fallback);
        } else {
            state.currentCwd = '';
            api.config.set('defaultCwd', '');
            renderCwdList();
            updateTabTints();
        }
    } else {
        renderCwdList();
    }
}

// Tint tabs that share the currently-selected cwd (subtle, doesn't override active).
function updateTabTints() {
    for (const tab of state.tabs) {
        tab.tabElement.classList.toggle(
            'tab--shared-cwd',
            !!state.currentCwd && tab.cwd === state.currentCwd
        );
    }
}

// ===== Welcome Screen =====
function setupWelcomeScreen() {
    const setupChoice = /** @type {HTMLElement} */ ($('#setup-choice'));
    const setupManual = /** @type {HTMLElement} */ ($('#setup-manual'));
    const btnManual = /** @type {HTMLElement} */ ($('#btn-manual-config'));
    const btnSave = /** @type {HTMLElement} */ ($('#btn-save-keys'));
    const btnLocalImport = /** @type {HTMLElement} */ ($('#btn-local-import'));

    // 点击"自行配置" → 展开手动配置表单
    btnManual?.addEventListener('click', () => {
        setupChoice.classList.add('hidden');
        setupManual.classList.remove('hidden');
    });

    // 点击"从本机导入" → 扫描 ~/.claude 和 ~/.codex 然后弹确认
    btnLocalImport?.addEventListener('click', async () => {
        await runLocalImport();
    });

    btnSave?.addEventListener('click', async () => {
        const anthropicKey = /** @type {HTMLInputElement} */ ($('#key-anthropic'))?.value?.trim();
        const openaiKey = /** @type {HTMLInputElement} */ ($('#key-openai'))?.value?.trim();
        const anthropicBaseUrl = /** @type {HTMLInputElement} */ ($('#baseurl-anthropic'))?.value?.trim();
        const openaiBaseUrl = /** @type {HTMLInputElement} */ ($('#baseurl-openai'))?.value?.trim();

        if (anthropicKey) {
            await api.config.setApiKey('anthropic', anthropicKey);
            updateSetupStatus('anthropic', true);
        }
        if (openaiKey) {
            await api.config.setApiKey('openai', openaiKey);
            updateSetupStatus('openai', true);
        }
        if (anthropicBaseUrl) {
            await api.config.setBaseUrl('anthropic', anthropicBaseUrl);
        }
        if (openaiBaseUrl) {
            await api.config.setBaseUrl('openai', openaiBaseUrl);
        }

        await api.config.set('firstLaunch', false);
        showAppScreen();
        await refreshToolStatus();
    });

    // 两处 4Router 登录按钮都打开应用内登录模态框
    $('#btn-login-4router')?.addEventListener('click', () => {
        openAuthModal();
    });
    $('#btn-login-4router-manual')?.addEventListener('click', () => {
        openAuthModal();
    });
    bindAuthModal();
}

function updateSetupStatus(/** @type {string} */ provider, /** @type {boolean} */ configured) {
    const el = document.getElementById(`status-${provider}`);
    if (el) {
        el.textContent = configured ? '已配置 ✓' : '未配置';
        el.classList.toggle('configured', configured);
    }
}

// ===== 4Router WebView Login Flow (兜底：网页登录) =====
async function handle4RouterLogin() {
    const btn1 = /** @type {HTMLButtonElement} */ ($('#btn-login-4router'));
    const btn2 = /** @type {HTMLButtonElement} */ ($('#btn-login-4router-manual'));
    const origText1 = btn1?.textContent;
    const origText2 = btn2?.textContent;

    try {
        // Disable buttons and show progress
        if (btn1) { btn1.textContent = '正在登录...'; btn1.disabled = true; }
        if (btn2) { btn2.textContent = '正在登录...'; btn2.disabled = true; }

        // Step 1: Open WebView login (AuthManager opens a child BrowserWindow)
        const loginResult = await api.auth.loginWebView();

        if (!loginResult.success) {
            // User cancelled or login failed
            if (loginResult.error !== '用户取消登录') {
                alert(`登录失败: ${loginResult.error}`);
            }
            return;
        }

        // Step 2-3: provision keys and enter the app
        await provisionAndEnter();

    } catch (err) {
        alert(`操作失败: ${err}`);
    } finally {
        if (btn1) { btn1.textContent = origText1; btn1.disabled = false; }
        if (btn2) { btn2.textContent = origText2; btn2.disabled = false; }
    }
}

// Shared post-login step: create API keys, then enter the main screen.
// Used by both the in-app modal login and the WebView fallback.
async function provisionAndEnter() {
    const provisionResult = await api.provision.createKeys();
    if (!provisionResult.success) {
        alert(`Key 创建失败: ${provisionResult.error}`);
        return false;
    }
    await api.config.set('firstLaunch', false);
    showAppScreen();
    await refreshToolStatus();
    return true;
}

// ===== In-app Login / Register Modal =====
let authMode = 'login'; // 'login' | 'register'

function openAuthModal() {
    authMode = 'login';
    applyAuthMode();
    const err = $('#auth-error');
    if (err) err.textContent = '';
    $('#auth-modal')?.classList.remove('hidden');
    /** @type {HTMLInputElement|null} */ ($('#auth-username'))?.focus();
}

function closeAuthModal() {
    $('#auth-modal')?.classList.add('hidden');
}

function applyAuthMode() {
    const isReg = authMode === 'register';
    const title = $('#auth-title');
    const submit = $('#btn-auth-submit');
    const toggle = $('#btn-auth-toggle-mode');
    if (title) title.textContent = isReg ? '注册 TokenWave' : '登录 TokenWave';
    if (submit) submit.textContent = isReg ? '注册' : '登录';
    if (toggle) toggle.textContent = isReg ? '已有账号？登录' : '没有账号？注册';
}

function toggleAuthMode() {
    authMode = authMode === 'login' ? 'register' : 'login';
    const err = $('#auth-error');
    if (err) err.textContent = '';
    applyAuthMode();
}

async function submitAuth() {
    const userEl = /** @type {HTMLInputElement} */ ($('#auth-username'));
    const passEl = /** @type {HTMLInputElement} */ ($('#auth-password'));
    const errEl = $('#auth-error');
    const submit = /** @type {HTMLButtonElement} */ ($('#btn-auth-submit'));
    const username = userEl?.value.trim() || '';
    const password = passEl?.value || '';

    if (errEl) errEl.textContent = '';
    if (!username || !password) {
        if (errEl) errEl.textContent = '请填写用户名和密码';
        return;
    }

    const origText = submit?.textContent;
    if (submit) { submit.textContent = '处理中…'; submit.disabled = true; }
    try {
        const result = authMode === 'register'
            ? await api.auth.register(username, password)
            : await api.auth.login(username, password);

        if (!result.success) {
            if (errEl) errEl.textContent = result.error || '操作失败';
            return;
        }
        closeAuthModal();
        await provisionAndEnter();
    } catch (err) {
        if (errEl) errEl.textContent = `操作失败: ${err}`;
    } finally {
        if (submit) { submit.textContent = origText; submit.disabled = false; }
    }
}

function bindAuthModal() {
    $('#btn-close-auth')?.addEventListener('click', closeAuthModal);
    $('#auth-overlay')?.addEventListener('click', closeAuthModal);
    $('#btn-auth-submit')?.addEventListener('click', () => { submitAuth(); });
    $('#btn-auth-toggle-mode')?.addEventListener('click', toggleAuthMode);
    $('#btn-auth-webview')?.addEventListener('click', () => {
        closeAuthModal();
        handle4RouterLogin();
    });
    // Enter 键在任一输入框内提交
    $('#auth-password')?.addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') submitAuth();
    });
    $('#auth-username')?.addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') submitAuth();
    });
}

// ===== Local Config Import =====
// Reads ~/.claude and ~/.codex from the user's home and copies them
// into TokenWave's private dirs so the bundled tools inherit hooks,
// MCP servers and credentials without manual entry.
async function runLocalImport() {
    const btn = /** @type {HTMLButtonElement} */ ($('#btn-local-import'));
    const orig = btn?.textContent;
    try {
        if (btn) { btn.textContent = '正在扫描...'; btn.disabled = true; }
        const scan = await api.localConfig.scan();

        if (!scan.claude.found && !scan.codex.found) {
            alert('未在本机找到 Claude Code 或 Codex 配置。\n\n查找路径：\n  ~/.claude/settings.json\n  ~/.codex/config.toml\n\n请先安装并登录任一工具，或选择"自行配置"。');
            return;
        }

        const hasAnthropic = await api.config.hasApiKey('anthropic');
        const hasOpenai = await api.config.hasApiKey('openai');
        const willOverwrite = hasAnthropic || hasOpenai;

        const confirmed = await showLocalImportPreview(scan, willOverwrite);
        if (!confirmed) return;

        if (btn) btn.textContent = '正在导入...';
        const result = await api.localConfig.apply(scan);

        showAppScreen();
        await refreshToolStatus();

        if (result.applied?.length) {
            console.log('[LocalImport] applied:', result.applied);
        }
    } catch (err) {
        alert(`导入失败: ${err}`);
    } finally {
        if (btn) { btn.textContent = orig; btn.disabled = false; }
    }
}

function escapeHtml(/** @type {string} */ s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderImportSection(/** @type {string} */ icon, /** @type {string} */ title, /** @type {Record<string, string|number|undefined>} */ fields) {
    const visible = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 0);
    const empty = visible.length === 0;
    const rows = empty
        ? '<div class="import-fields"><span class="value value-mute" style="grid-column:1/-1">未在本机找到对应配置文件</span></div>'
        : '<div class="import-fields">' +
          visible.map(([k, v]) => `<span class="label">${escapeHtml(k)}</span><span class="value">${escapeHtml(String(v))}</span>`).join('') +
          '</div>';
    return `
        <div class="import-section ${empty ? 'import-section-empty' : ''}">
            <div class="import-section-title">
                <span class="import-icon">${icon}</span>
                <span>${escapeHtml(title)}</span>
                <span class="import-status">${empty ? '未找到' : '已检测'}</span>
            </div>
            ${rows}
        </div>
    `;
}

function maskKey(/** @type {string|undefined} */ key) {
    if (!key) return undefined;
    if (key.length <= 16) return key.slice(0, 6) + '…';
    return key.slice(0, 10) + '…' + key.slice(-4);
}

async function showLocalImportPreview(/** @type {any} */ scan, /** @type {boolean} */ willOverwrite) {
    const modal = $('#local-import-modal');
    const body = $('#local-import-body');
    if (!modal || !body) return false;

    const claudeHtml = renderImportSection('🟣', 'Claude Code  ~/.claude/settings.json', {
        'API Key': maskKey(scan.claude.apiKey),
        'Base URL': scan.claude.baseUrl,
        'Model': scan.claude.model,
        'Hooks': scan.claude.hooksCount ? `${scan.claude.hooksCount} 项` : undefined,
        'Allow rules': scan.claude.permissionsAllow ? `${scan.claude.permissionsAllow} 条` : undefined,
    });
    const codexHtml = renderImportSection('🟢', 'Codex CLI  ~/.codex/', {
        'API Key': maskKey(scan.codex.apiKey),
        'Base URL': scan.codex.baseUrl,
        'Model': scan.codex.model,
        'MCP servers': scan.codex.mcpServersCount ? `${scan.codex.mcpServersCount} 个` : undefined,
        'Trusted projects': scan.codex.projectsCount ? `${scan.codex.projectsCount} 个` : undefined,
    });
    const warning = willOverwrite
        ? '<div class="import-warning">⚠️ 检测到 TokenWave 已存在配置，导入将覆盖现有 API Key、Base URL 与模型设置。Hooks / MCP 服务器会被合并。</div>'
        : '';
    body.innerHTML = claudeHtml + codexHtml + warning;

    modal.classList.remove('hidden');

    return await new Promise(resolve => {
        const cleanup = () => {
            modal.classList.add('hidden');
            $('#btn-confirm-local-import')?.removeEventListener('click', onConfirm);
            $('#btn-cancel-local-import')?.removeEventListener('click', onCancel);
            $('#btn-close-local-import')?.removeEventListener('click', onCancel);
            $('#local-import-overlay')?.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
        };
        const onConfirm = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const onKey = (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter') onConfirm();
        };
        $('#btn-confirm-local-import')?.addEventListener('click', onConfirm);
        $('#btn-cancel-local-import')?.addEventListener('click', onCancel);
        $('#btn-close-local-import')?.addEventListener('click', onCancel);
        $('#local-import-overlay')?.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

// ===== Sidebar =====
function setupSidebar() {
    $('#btn-launch-claude')?.addEventListener('click', () => launchTool('claude-code'));
    $('#btn-launch-codex')?.addEventListener('click', () => launchTool('codex'));
    $('#btn-launch-terminal')?.addEventListener('click', () => launchTerminal());
    $('#btn-launch-image')?.addEventListener('click', () => openImageTab());

    // Update tool buttons
    document.getElementById('badge-claude')?.addEventListener('click', (e) => {
        e.stopPropagation();
        updateTool('claude-code', 'badge-claude');
    });
    document.getElementById('badge-codex')?.addEventListener('click', (e) => {
        e.stopPropagation();
        updateTool('codex', 'badge-codex');
    });

    $('#btn-add-cwd')?.addEventListener('click', () => addCwd());

    $('#btn-settings')?.addEventListener('click', () => openSettings());

    $('#btn-history')?.addEventListener('click', () => openHistory());
    $('#btn-close-history')?.addEventListener('click', () => closeHistory());
    $('#history-overlay')?.addEventListener('click', () => closeHistory());

    $('#btn-account')?.addEventListener('click', () => openAccount());

    $('#btn-open-website')?.addEventListener('click', () => {
        window.open('https://api.dshub.top');
    });

    $('#btn-open-images')?.addEventListener('click', async () => {
        const result = await api.tools.openGeneratedImages();
        if (!result?.success) {
            alert(`打开图片目录失败: ${result?.error || '未知错误'}`);
        }
    });

    setupAppUpdateButton();

    refreshToolStatus();
}

// ===== App Update (GitHub Releases) =====
function setupAppUpdateButton() {
    const btn = /** @type {HTMLElement} */ ($('#btn-check-update'));
    const statusText = /** @type {HTMLElement} */ ($('#update-status-text'));
    if (!btn || !statusText) return;

    /** @type {{ downloadUrl: string; latestVersion: string } | null} */
    let pendingUpdate = null;
    let isWorking = false;

    // Listen for download progress events
    api.app.onUpdateProgress((/** @type {number} */ percent, /** @type {string|undefined} */ message) => {
        if (message) {
            statusText.textContent = message;
        } else if (percent >= 0) {
            statusText.textContent = `下载中 ${percent}%`;
        }
    });

    btn.addEventListener('click', async () => {
        if (isWorking) return;

        // If we already know there's an update, download it
        if (pendingUpdate) {
            isWorking = true;
            statusText.textContent = '正在测速...';
            btn.classList.remove('updatable');
            btn.classList.add('updating');

            try {
                const result = await api.app.downloadUpdate(pendingUpdate.downloadUrl);
                if (result.success) {
                    statusText.textContent = '下载完成，请安装';
                } else {
                    statusText.textContent = '下载失败';
                    console.error('Download failed:', result.error);
                    setTimeout(() => {
                        statusText.textContent = '点击更新';
                        btn.classList.add('updatable');
                    }, 3000);
                }
            } catch (err) {
                statusText.textContent = '下载失败';
                console.error('Download error:', err);
                setTimeout(() => {
                    statusText.textContent = '点击更新';
                    btn.classList.add('updatable');
                }, 3000);
            } finally {
                isWorking = false;
                btn.classList.remove('updating');
            }
            return;
        }

        // Check for update
        isWorking = true;
        statusText.textContent = '检查中...';

        try {
            const result = await api.app.checkAppUpdate();
            if (result.hasUpdate && result.downloadUrl) {
                pendingUpdate = { downloadUrl: result.downloadUrl, latestVersion: result.latestVersion };
                statusText.textContent = '点击更新';
                btn.title = `${result.currentVersion} → ${result.latestVersion}`;
                btn.classList.add('updatable');
            } else if (result.hasUpdate) {
                statusText.textContent = `新版本 v${result.latestVersion}`;
                btn.title = '未找到下载文件，请前往 GitHub 手动下载';
            } else {
                statusText.textContent = '已是最新';
                btn.title = `当前版本: v${result.currentVersion}`;
                setTimeout(() => { statusText.textContent = '检查更新'; }, 3000);
            }
        } catch (err) {
            statusText.textContent = '检查失败';
            console.error('Update check error:', err);
            setTimeout(() => { statusText.textContent = '检查更新'; }, 3000);
        } finally {
            isWorking = false;
        }
    });

    // Auto-check on startup (silent, non-blocking)
    api.app.checkAppUpdate().then((/** @type {any} */ result) => {
        if (result.hasUpdate && result.downloadUrl) {
            pendingUpdate = { downloadUrl: result.downloadUrl, latestVersion: result.latestVersion };
            statusText.textContent = '点击更新';
            btn.title = `${result.currentVersion} → ${result.latestVersion}`;
            btn.classList.add('updatable');
        }
    }).catch(() => { /* ignore startup check failures */ });
}

async function refreshToolStatus() {
    const tools = await api.tools.list();
    for (const tool of tools) {
        const badgeEl = tool.id === 'claude-code'
            ? document.getElementById('badge-claude')
            : document.getElementById('badge-codex');
        if (badgeEl) {
            if (!tool.available) {
                badgeEl.textContent = '未安装';
                badgeEl.className = 'tool-badge unavailable';
            } else {
                badgeEl.textContent = tool.version || '就绪';
                badgeEl.className = 'tool-badge';

                // Async update check — non-blocking
                const toolId = tool.id;
                api.tools.checkUpdate(toolId).then((/** @type {any} */ result) => {
                    if (result.hasUpdate && badgeEl) {
                        badgeEl.textContent = '点击更新';
                        badgeEl.className = 'tool-badge updatable';
                        badgeEl.title = `${result.currentVersion} → ${result.latestVersion}`;
                    }
                }).catch(() => { /* ignore check failures */ });
            }
        }
    }
}

// ===== Update Tool =====
async function updateTool(/** @type {string} */ toolId, /** @type {string} */ badgeId) {
    const badgeEl = document.getElementById(badgeId);
    if (!badgeEl) return;

    const origText = badgeEl.textContent;
    badgeEl.textContent = '更新中...';
    badgeEl.className = 'tool-badge updating';
    badgeEl.style.pointerEvents = 'none';

    try {
        const result = await api.tools.update(toolId);
        if (result.success) {
            badgeEl.textContent = result.version || '已更新 ✓';
            badgeEl.className = 'tool-badge';
        } else {
            badgeEl.textContent = '更新失败';
            badgeEl.className = 'tool-badge unavailable';
            console.error('Update failed:', result.error);
            alert(`更新失败:\n${result.error}`);
            setTimeout(() => { badgeEl.textContent = origText; badgeEl.className = 'tool-badge'; }, 3000);
        }
    } catch (err) {
        badgeEl.textContent = '更新失败';
        badgeEl.className = 'tool-badge unavailable';
        console.error('Update error:', err);
        setTimeout(() => { badgeEl.textContent = origText; badgeEl.className = 'tool-badge'; }, 3000);
    } finally {
        badgeEl.style.pointerEvents = '';
    }
}

// ===== Launch Tool =====
async function launchTool(/** @type {string} */ toolId) {
    const tools = await api.tools.list();
    const tool = tools.find((/** @type {any} */ t) => t.id === toolId);
    if (!tool) return;

    if (!tool.available) {
        alert(`${tool.name} 的内置运行时或工具文件缺失。\n请重新安装应用，或重新执行打包流程。`);
        return;
    }

    // Check API key
    const hasKey = await api.config.hasApiKey(tool.provider);
    if (!hasKey) {
        const keyPrompt = prompt(`请输入 ${tool.envKeyName}:`);
        if (!keyPrompt) return;
        await api.config.setApiKey(tool.provider, keyPrompt);
    }

    try {
        const sessionId = await api.pty.create(toolId, state.currentCwd || undefined);
        createTab(toolId, tool.name, tool.icon, sessionId);

        const badgeEl = toolId === 'claude-code'
            ? document.getElementById('badge-claude')
            : document.getElementById('badge-codex');
        if (badgeEl) {
            badgeEl.textContent = '运行中';
            badgeEl.className = 'tool-badge running';
        }
    } catch (err) {
        console.error('Failed to launch tool:', err);
        alert(`启动 ${tool.name} 失败: ${err}`);
    }
}

// ===== Launch Terminal =====
async function launchTerminal() {
    try {
        const sessionId = await api.pty.create('terminal', state.currentCwd || undefined);
        createTab('terminal', 'Terminal', '⬛', sessionId);
    } catch (err) {
        console.error('Failed to launch terminal:', err);
        alert(`启动终端失败: ${err}`);
    }
}

// ===== Session History =====
const TOOL_DISPLAY = {
    'claude-code': { name: 'Claude Code', icon: '🟣' },
    'codex': { name: 'Codex CLI', icon: '🟢' },
};

// Virtual scroll: rows are absolutely positioned inside a fixed-height sizer,
// and only the rows intersecting the viewport (plus overscan) are in the DOM.
const HISTORY_ROW_HEIGHT = 64; // px — must match .history-item height in CSS
const HISTORY_OVERSCAN = 4;

const historyState = {
    /** @type {any[]} */ all: [],
    /** @type {any[]} */ filtered: [],
    query: '',
    bound: false,
};

function formatRelativeTime(/** @type {number} */ ms) {
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(ms).toLocaleDateString();
}

async function openHistory() {
    const modal = /** @type {HTMLElement} */ ($('#history-modal'));
    const list = /** @type {HTMLElement} */ ($('#history-list'));
    modal.classList.remove('hidden');
    bindHistoryEvents();
    list.innerHTML = '<div class="history-empty">加载中…</div>';

    const res = await api.sessions.list();
    if (!res?.success) {
        historyState.all = [];
        historyState.filtered = [];
        updateHistoryCount();
        list.innerHTML = `<div class="history-empty">加载失败: ${escapeHtml(res?.error || '未知错误')}</div>`;
        return;
    }
    historyState.all = res.data || [];
    const input = /** @type {HTMLInputElement} */ ($('#history-search-input'));
    historyState.query = (input?.value || '').trim().toLowerCase();
    applyHistoryFilter();
}

function closeHistory() {
    $('#history-modal')?.classList.add('hidden');
}

// Bind search + scroll listeners exactly once (the modal nodes persist).
function bindHistoryEvents() {
    if (historyState.bound) return;
    historyState.bound = true;
    const input = /** @type {HTMLInputElement} */ ($('#history-search-input'));
    const list = /** @type {HTMLElement} */ ($('#history-list'));
    let timer;
    input?.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            historyState.query = (input.value || '').trim().toLowerCase();
            applyHistoryFilter();
        }, 120);
    });
    list?.addEventListener('scroll', () => renderHistoryViewport());
}

function applyHistoryFilter() {
    const q = historyState.query;
    historyState.filtered = q
        ? historyState.all.filter((s) =>
            `${s.title || ''} ${s.cwd || ''}`.toLowerCase().includes(q))
        : historyState.all.slice();
    updateHistoryCount();

    const list = /** @type {HTMLElement} */ ($('#history-list'));
    if (!list) return;
    if (historyState.all.length === 0) {
        list.innerHTML = '<div class="history-empty">暂无历史会话。启动 Claude Code 或 Codex 对话后会出现在这里。</div>';
        return;
    }
    if (historyState.filtered.length === 0) {
        list.innerHTML = '<div class="history-empty">没有匹配的会话。</div>';
        return;
    }
    list.scrollTop = 0;
    list.innerHTML = '<div class="history-sizer"></div>';
    const sizer = /** @type {HTMLElement} */ (list.querySelector('.history-sizer'));
    sizer.style.height = `${historyState.filtered.length * HISTORY_ROW_HEIGHT}px`;
    renderHistoryViewport();
}

function updateHistoryCount() {
    const el = $('#history-count');
    if (!el) return;
    const total = historyState.all.length;
    if (!total) { el.textContent = ''; return; }
    el.textContent = historyState.query
        ? `${historyState.filtered.length} / ${total}`
        : `${total} 条`;
}

function renderHistoryViewport() {
    const list = /** @type {HTMLElement} */ ($('#history-list'));
    const sizer = /** @type {HTMLElement} */ (list?.querySelector('.history-sizer'));
    if (!list || !sizer) return;
    const total = historyState.filtered.length;
    const viewport = list.clientHeight || 400;
    const top = list.scrollTop;
    const start = Math.max(0, Math.floor(top / HISTORY_ROW_HEIGHT) - HISTORY_OVERSCAN);
    const end = Math.min(total, Math.ceil((top + viewport) / HISTORY_ROW_HEIGHT) + HISTORY_OVERSCAN);

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
        frag.appendChild(buildHistoryItem(historyState.filtered[i], i));
    }
    sizer.innerHTML = '';
    sizer.appendChild(frag);
}

function buildHistoryItem(/** @type {any} */ s, /** @type {number} */ index) {
    const meta = TOOL_DISPLAY[/** @type {keyof typeof TOOL_DISPLAY} */ (s.tool)] || { name: s.tool, icon: '⬛' };
    const cwdTail = (s.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
    const item = document.createElement('button');
    item.className = 'history-item';
    item.style.top = `${index * HISTORY_ROW_HEIGHT}px`;
    item.innerHTML =
        `<span class="history-item-icon">${meta.icon}</span>` +
        `<span class="history-item-main">` +
        `<span class="history-item-title">${escapeHtml(s.title || '未命名会话')}</span>` +
        `<span class="history-item-meta">${escapeHtml(meta.name)} · ${escapeHtml(cwdTail || '~')} · ${formatRelativeTime(s.updatedAt)}</span>` +
        `</span>`;
    item.addEventListener('click', () => resumeSession(s));
    return item;
}

async function resumeSession(/** @type {any} */ s) {
    const tools = await api.tools.list();
    const tool = tools.find((/** @type {any} */ t) => t.id === s.tool);
    if (!tool) {
        toast('该工具不可用', 'error');
        return;
    }
    if (!tool.available) {
        toast(`${tool.name} 的内置运行时缺失`, 'error');
        return;
    }
    const hasKey = await api.config.hasApiKey(tool.provider);
    if (!hasKey) {
        toast(`请先在设置中配置 ${tool.name} 的 API Key`, 'error');
        return;
    }
    try {
        // Resume must reuse the session's original cwd — Claude organizes
        // sessions by cwd-encoded directory, so a mismatched cwd won't find it.
        const cwd = s.cwd || state.currentCwd || undefined;
        const sessionId = await api.pty.create(s.tool, cwd, s.id);
        createTab(s.tool, tool.name, tool.icon, sessionId);
        closeHistory();
    } catch (err) {
        console.error('Failed to resume session:', err);
        toast(`恢复会话失败: ${err}`, 'error');
    }
}


/**
 * Send an image file path to the PTY using xterm bracketed-paste markers,
 * matching how Claude Code's CLI detects pasted image attachments.
 * @param {string} sessionId
 * @param {string} imagePath
 */
function writeImagePathToPty(sessionId, imagePath) {
    const BRACKET_PASTE_START = '\x1b[200~';
    const BRACKET_PASTE_END = '\x1b[201~';
    api.pty.write(sessionId, `${BRACKET_PASTE_START} ${imagePath}${BRACKET_PASTE_END}`);
}

/**
 * Paste clipboard contents into the PTY.
 * Falls back to image (saved as temp file, path sent wrapped in bracketed
 * paste markers) when the clipboard has no text.
 * @param {string} sessionId
 */
async function pasteFromClipboard(sessionId) {
    try {
        // Try text first — covers normal text paste and mixed text+image clipboards
        // (where the user meant to paste the text).
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            text = '';
        }
        if (text) {
            api.pty.write(sessionId, text);
            return;
        }

        // No text — try an image. Main process writes a temp .png and returns the path.
        const imagePath = await api.clipboard?.readImage?.();
        if (imagePath) {
            writeImagePathToPty(sessionId, imagePath);
        }
    } catch (err) {
        console.error('[pasteFromClipboard] failed:', err);
    }
}

/**
 * Forward dropped image files into the active PTY using the same
 * bracketed-paste path as the clipboard image flow.
 * @param {string} sessionId
 * @param {FileList | File[]} files
 */
async function dropImagesToPty(sessionId, files) {
    const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    for (const file of list) {
        try {
            const buf = await file.arrayBuffer();
            const ext = (file.name.split('.').pop() || '').toLowerCase()
                || (file.type.split('/')[1] || 'png');
            const path = await api.clipboard?.saveDroppedImage?.(buf, ext);
            if (path) writeImagePathToPty(sessionId, path);
        } catch (err) {
            console.error('[dropImagesToPty] failed for', file.name, err);
        }
    }
}

// ===== Tab Management =====
function createTab(
  /** @type {string} */ toolId,
  /** @type {string} */ toolName,
  /** @type {string} */ toolIcon,
  /** @type {string} */ sessionId
) {
    const tabId = `tab-${++state.tabCounter}`;
    const themeName = document.documentElement.getAttribute('data-theme') || 'dark';

    const terminal = new Terminal({
        theme: getTerminalTheme(themeName),
        fontSize: 14,
        fontFamily: 'JetBrains Mono, Consolas, monospace',
        cursorBlink: true,
        cursorStyle: 'bar',
        allowProposedApi: true,
        scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = `terminal-${tabId}`;
    terminalContainer.appendChild(wrapper);
    terminal.open(wrapper);

    // ---- Drag & drop image attachment ----
    // Override Electron's default behavior of navigating to file:// when an image
    // is dropped onto the window, and forward the bytes to the PTY instead.
    wrapper.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        const hasFile = Array.from(e.dataTransfer.items || []).some((it) => it.kind === 'file');
        if (!hasFile) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        wrapper.classList.add('drop-target');
    });
    wrapper.addEventListener('dragleave', () => {
        wrapper.classList.remove('drop-target');
    });
    wrapper.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        wrapper.classList.remove('drop-target');
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        e.preventDefault();
        await dropImagesToPty(sessionId, files);
        terminal.focus();
    });

    // ---- Floating copy/paste toolbar ----
    const toolbar = document.createElement('div');
    toolbar.className = 'terminal-toolbar';
    toolbar.innerHTML = `
        <button class="toolbar-btn" data-action="copy" title="Copy">📋 Copy</button>
        <button class="toolbar-btn" data-action="paste" title="Paste">📥 Paste</button>
    `;
    wrapper.appendChild(toolbar);

    toolbar.addEventListener('click', async (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'copy') {
            const sel = terminal.getSelection();
            if (sel) {
                await navigator.clipboard.writeText(sel);
                terminal.clearSelection();
                btn.textContent = '✅ Copied';
                setTimeout(() => { btn.textContent = '📋 Copy'; }, 1000);
            }
        } else if (action === 'paste') {
            await pasteFromClipboard(sessionId);
            terminal.focus();
        }
    });

    // Show/hide toolbar on selection
    terminal.onSelectionChange(() => {
        const sel = terminal.getSelection();
        toolbar.classList.toggle('has-selection', !!sel);
    });

    // ---- Keyboard interception ----
    terminal.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        // Ctrl+C: always intercept — copy if selected, otherwise do nothing (no SIGINT)
        if (e.ctrlKey && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) {
            const sel = terminal.getSelection();
            if (sel) {
                navigator.clipboard.writeText(sel);
                terminal.clearSelection();
            }
            return false; // never send Ctrl+C to PTY
        }
        // Ctrl+V: paste from clipboard (text or image)
        if (e.ctrlKey && (e.code === 'KeyV' || e.key === 'v' || e.key === 'V')) {
            e.preventDefault();
            pasteFromClipboard(sessionId);
            return false;
        }
        return true;
    });

    // Forward input to PTY
    terminal.onData((data) => {
        api.pty.write(sessionId, data);
    });

    // Create tab element
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-tab-id', tabId);
    tabEl.innerHTML = `
    <span>${toolIcon}</span>
    <span>${toolName}</span>
    <span class="tab-close" title="关闭">&times;</span>
  `;
    tabEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */(e.target)?.closest('.tab-close')) {
            closeTab(tabId);
        } else {
            activateTab(tabId);
        }
    });
    tabBar.appendChild(tabEl);

    const tabState = {
        id: tabId,
        kind: /** @type {'terminal'} */ ('terminal'),
        toolId,
        toolName,
        toolIcon,
        sessionId,
        terminal,
        fitAddon,
        wrapper,
        tabElement: tabEl,
        cwd: state.currentCwd || '',
    };
    state.tabs.push(tabState);

    activateTab(tabId);
    refitTerminal(tabState);
    tabBarEmpty.classList.add('hidden');
    emptyState.classList.add('hidden');
}

// ===== Editor Tabs =====
// Open a file in a CodeMirror editor tab. Reuses the existing tab if the same
// file is already open; otherwise loads the file via IPC and mounts an editor.
async function openFileInEditor(/** @type {string} */ filePath, /** @type {string} */ fileName) {
    const existing = state.tabs.find(t => t.kind === 'editor' && t.filePath === filePath);
    if (existing) {
        activateTab(existing.id);
        return;
    }

    const res = await api.fs.readFile(filePath);
    if (!res?.success) {
        toast(res?.error || '无法打开文件', 'error');
        return;
    }

    const tabId = `tab-${++state.tabCounter}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'editor-wrapper';
    wrapper.id = `editor-${tabId}`;
    terminalContainer.appendChild(wrapper);

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-tab-id', tabId);
    tabEl.innerHTML = `
    <span>📄</span>
    <span class="tab-title">${escapeHtml(fileName)}</span>
    <span class="tab-dirty" title="未保存">●</span>
    <span class="tab-close" title="关闭">&times;</span>
  `;
    tabEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */(e.target)?.closest('.tab-close')) {
            closeTab(tabId);
        } else {
            activateTab(tabId);
        }
    });
    tabBar.appendChild(tabEl);

    const tabState = {
        id: tabId,
        kind: /** @type {'editor'} */ ('editor'),
        toolId: 'editor',
        toolName: fileName,
        toolIcon: '📄',
        filePath,
        dirty: false,
        wrapper,
        tabElement: tabEl,
        cwd: state.currentCwd || '',
    };

    const markDirty = () => {
        if (!tabState.dirty) {
            tabState.dirty = true;
            tabEl.classList.add('dirty');
        }
    };
    const doSave = () => saveEditorTab(tabState);

    const editor = createEditor(wrapper, fileName, res.content || '', markDirty, doSave);
    tabState.editor = editor;

    state.tabs.push(tabState);
    activateTab(tabId);
    tabBarEmpty.classList.add('hidden');
    emptyState.classList.add('hidden');
}

async function saveEditorTab(/** @type {TabState} */ tabState) {
    if (tabState.kind !== 'editor' || !tabState.editor || !tabState.filePath) return;
    const content = tabState.editor.state.doc.toString();
    const res = await api.fs.writeFile(tabState.filePath, content);
    if (res?.success) {
        tabState.dirty = false;
        tabState.tabElement.classList.remove('dirty');
        toast('已保存');
    } else {
        toast(res?.error || '保存失败', 'error');
    }
}

// Open (or focus) the standalone image-generation tab. Only one is allowed —
// reusing it avoids stacking duplicate panels.
function openImageTab() {
    const existing = state.tabs.find(t => t.kind === 'image');
    if (existing) {
        activateTab(existing.id);
        return;
    }

    const tabId = `tab-${++state.tabCounter}`;

    const wrapper = document.createElement('div');
    wrapper.className = 'image-wrapper';
    wrapper.id = `image-${tabId}`;
    terminalContainer.appendChild(wrapper);

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.setAttribute('data-tab-id', tabId);
    tabEl.innerHTML = `
    <span>🎨</span>
    <span class="tab-title">生图</span>
    <span class="tab-close" title="关闭">&times;</span>
  `;
    tabEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */(e.target)?.closest('.tab-close')) {
            closeTab(tabId);
        } else {
            activateTab(tabId);
        }
    });
    tabBar.appendChild(tabEl);

    const panel = createImagePanel(wrapper, api, { onToast: toast });

    const tabState = {
        id: tabId,
        kind: /** @type {'image'} */ ('image'),
        toolId: 'image',
        toolName: '生图',
        toolIcon: '🎨',
        wrapper,
        tabElement: tabEl,
        panel,
        cwd: state.currentCwd || '',
    };

    state.tabs.push(tabState);
    activateTab(tabId);
    tabBarEmpty.classList.add('hidden');
    emptyState.classList.add('hidden');
}

function activateTab(/** @type {string} */ tabId) {
    state.activeTabId = tabId;

    for (const tab of state.tabs) {
        const isActive = tab.id === tabId;
        tab.tabElement.classList.toggle('active', isActive);
        tab.wrapper.classList.toggle('hidden', !isActive);
        if (isActive) {
            if (tab.kind === 'terminal') {
                refitTerminal(tab, { focus: true });
            } else if (tab.kind === 'editor' && tab.editor) {
                tab.editor.focus();
            }
            // currentCwd follows the active tab so the directory list highlights
            // whatever the focused session is bound to.
            if (tab.cwd) {
                state.currentCwd = tab.cwd;
                loadFileTree(tab.cwd);
            }
        }
    }
    renderCwdList();
    updateTabTints();
}

function closeTab(/** @type {string} */ tabId) {
    const idx = state.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = state.tabs[idx];

    if (tab.kind === 'editor') {
        if (tab.dirty && !confirm(`「${tab.toolName}」有未保存的修改，确定关闭吗？`)) {
            return;
        }
        tab.editor?.destroy();
    } else if (tab.kind === 'image') {
        tab.panel?.destroy?.();
    } else {
        if (tab.sessionId) api.pty.destroy(tab.sessionId);
        tab.terminal?.dispose();
    }
    tab.wrapper.remove();
    tab.tabElement.remove();
    state.tabs.splice(idx, 1);

    if (state.tabs.length === 0) {
        state.activeTabId = null;
        tabBarEmpty.classList.remove('hidden');
        emptyState.classList.remove('hidden');
        refreshToolStatus();
    } else if (state.activeTabId === tabId) {
        const newIdx = Math.min(idx, state.tabs.length - 1);
        activateTab(state.tabs[newIdx].id);
    }
    // Refresh the directory list so the closed tab's .bound dot clears.
    renderCwdList();
    updateTabTints();
}

// ===== PTY Listeners =====
function setupPtyListeners() {
    api.pty.onData((/** @type {string} */ sessionId, /** @type {string} */ data) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.terminal.write(data);
        }
    });

    api.pty.onExit((/** @type {string} */ sessionId, /** @type {number} */ exitCode) => {
        const tab = state.tabs.find(t => t.sessionId === sessionId);
        if (tab) {
            tab.terminal.writeln(`\r\n\x1b[90m[进程已退出，代码: ${exitCode}]\x1b[0m`);
        }
        refreshToolStatus();
    });
}

// ===== Resize Handling =====
function setupResize() {
    let resizeTimer = /** @type {any} */ (null);
    const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const activeTab = state.tabs.find(t => t.id === state.activeTabId);
            if (activeTab) {
                refitTerminal(activeTab);
            }
        }, 100);
    });
    resizeObserver.observe(terminalContainer);
}

// ===== Settings Modal =====
function setupSettings() {
    const btnClose = /** @type {HTMLElement} */ ($('#btn-close-settings'));
    const btnSave = /** @type {HTMLElement} */ ($('#btn-save-settings'));
    const btnCancel = /** @type {HTMLElement} */ ($('#btn-cancel-settings'));
    const btnLogout = /** @type {HTMLButtonElement} */ ($('#btn-logout'));
    const overlay = settingsModal.querySelector('.modal-overlay');

    const closeModal = () => settingsModal.classList.add('hidden');

    btnClose?.addEventListener('click', closeModal);
    btnCancel?.addEventListener('click', closeModal);
    overlay?.addEventListener('click', closeModal);

    btnLogout?.addEventListener('click', async () => {
        const ok = confirm('退出会清除 TokenWave 程序内保存的登录态和 API Key，不会影响你本机 ~/.claude、~/.codex 的原有配置。\n\n下次启动需要重新登录或重新导入。要继续吗？');
        if (!ok) return;
        try {
            await api.auth.logout();
            // Also clear the provisioned API keys so the next session re-runs
            // the full login + provision flow against potentially-rotated keys.
            await api.config.setApiKey('anthropic', '');
            await api.config.setApiKey('openai', '');
            await api.config.set('firstLaunch', true);
            closeModal();
            // Reload window to drop in-memory tab state and land on welcome page
            location.reload();
        } catch (err) {
            alert(`退出登录失败: ${err}`);
        }
    });

    btnSave?.addEventListener('click', async () => {
        const anthropicKey = /** @type {HTMLInputElement} */ ($('#settings-key-anthropic'))?.value?.trim();
        const openaiKey = /** @type {HTMLInputElement} */ ($('#settings-key-openai'))?.value?.trim();
        const anthropicBaseUrl = /** @type {HTMLInputElement} */ ($('#settings-baseurl-anthropic'))?.value?.trim();
        const openaiBaseUrl = /** @type {HTMLInputElement} */ ($('#settings-baseurl-openai'))?.value?.trim();
        const proxy = /** @type {HTMLInputElement} */ ($('#settings-proxy'))?.value?.trim();
        const fontSize = parseInt(/** @type {HTMLInputElement} */($('#settings-fontsize'))?.value || '14');
        const fontFamily = /** @type {HTMLInputElement} */ ($('#settings-fontfamily'))?.value?.trim();

        const anthropicModel = /** @type {HTMLInputElement} */ ($('#settings-model-anthropic'))?.value?.trim();
        const openaiModel = /** @type {HTMLInputElement} */ ($('#settings-model-openai'))?.value?.trim();

        if (anthropicKey) await api.config.setApiKey('anthropic', anthropicKey);
        if (openaiKey) await api.config.setApiKey('openai', openaiKey);
        if (anthropicBaseUrl) await api.config.setBaseUrl('anthropic', anthropicBaseUrl);
        if (openaiBaseUrl) await api.config.setBaseUrl('openai', openaiBaseUrl);
        if (anthropicModel) await api.config.setModel('anthropic', anthropicModel);
        if (openaiModel) await api.config.setModel('openai', openaiModel);
        const ccEffort = /** @type {HTMLInputElement} */ ($('#settings-cc-effort'))?.value?.trim();
        await api.config.set('ccEffortLevel', ccEffort || '');
        const ccBypassPermissions = /** @type {HTMLInputElement} */ ($('#settings-cc-bypass-permissions'))?.checked || false;
        await api.config.set('ccBypassPermissions', ccBypassPermissions);
        const codexBypassPermissions = /** @type {HTMLInputElement} */ ($('#settings-codex-bypass-permissions'))?.checked || false;
        await api.config.set('codexBypassPermissions', codexBypassPermissions);
        const reasoningEffort = /** @type {HTMLInputElement} */ ($('#settings-reasoning-effort'))?.value?.trim();
        const verbosity = /** @type {HTMLInputElement} */ ($('#settings-verbosity'))?.value?.trim();
        if (reasoningEffort) await api.config.set('codexReasoningEffort', reasoningEffort);
        if (verbosity) await api.config.set('codexVerbosity', verbosity);
        await api.config.set('proxy', proxy || '');
        await api.config.set('fontSize', fontSize);
        await api.config.set('fontFamily', fontFamily || 'JetBrains Mono, Consolas, monospace');

        // Theme
        const theme = /** @type {HTMLSelectElement} */ ($('#settings-theme'))?.value || 'dark';
        await api.config.set('theme', theme);
        applyTheme(theme);

        closeModal();
    });
}

async function openSettings() {
    // Pre-fill current config values
    const proxy = await api.config.get('proxy');
    const fontSize = await api.config.get('fontSize');
    const fontFamily = await api.config.get('fontFamily');
    const anthropicBaseUrl = await api.config.getBaseUrl('anthropic');
    const openaiBaseUrl = await api.config.getBaseUrl('openai');
    const theme = await api.config.get('theme');

    // Login status indicator in the Account section.
    const loggedIn = await api.auth.isLoggedIn();
    const hasAnyKey = (await api.config.hasApiKey('anthropic')) || (await api.config.hasApiKey('openai'));
    const statusEl = $('#account-status-text');
    const logoutBtn = /** @type {HTMLButtonElement} */ ($('#btn-logout'));
    if (statusEl) {
        statusEl.textContent = loggedIn ? '已登录 TokenWave' : '未登录';
        statusEl.style.color = loggedIn ? '#3fb950' : '#8b949e';
    }
    // Enable when there's anything to clear — logged in OR local keys were
    // imported without a TokenWave login. Otherwise the button is disabled
    // and a click produces no response at all.
    if (logoutBtn) logoutBtn.disabled = !(loggedIn || hasAnyKey);

    const themeSelect = /** @type {HTMLSelectElement} */ ($('#settings-theme'));
    if (themeSelect) themeSelect.value = theme || 'fruit';

    const proxyInput = /** @type {HTMLInputElement} */ ($('#settings-proxy'));
    const fontSizeInput = /** @type {HTMLInputElement} */ ($('#settings-fontsize'));
    const fontFamilyInput = /** @type {HTMLInputElement} */ ($('#settings-fontfamily'));
    const anthropicBaseUrlInput = /** @type {HTMLInputElement} */ ($('#settings-baseurl-anthropic'));
    const openaiBaseUrlInput = /** @type {HTMLInputElement} */ ($('#settings-baseurl-openai'));

    if (proxyInput) proxyInput.value = proxy || '';
    if (fontSizeInput) fontSizeInput.value = String(fontSize || 14);
    if (fontFamilyInput) fontFamilyInput.value = fontFamily || 'JetBrains Mono, Consolas, monospace';
    if (anthropicBaseUrlInput) anthropicBaseUrlInput.value = anthropicBaseUrl || '';
    if (openaiBaseUrlInput) openaiBaseUrlInput.value = openaiBaseUrl || '';

    // Load model settings
    const anthropicModel = await api.config.getModel('anthropic');
    const openaiModel = await api.config.getModel('openai');
    const anthropicModelInput = /** @type {HTMLInputElement} */ ($('#settings-model-anthropic'));
    const openaiModelInput = /** @type {HTMLInputElement} */ ($('#settings-model-openai'));
    if (anthropicModelInput) anthropicModelInput.value = anthropicModel || '';
    if (openaiModelInput) openaiModelInput.value = openaiModel || '';

    // Load Claude Code effort level
    const ccEffort = await api.config.get('ccEffortLevel');
    const ccEffortInput = /** @type {HTMLInputElement} */ ($('#settings-cc-effort'));
    if (ccEffortInput) ccEffortInput.value = ccEffort || '';

    // Load Claude Code bypass-permissions toggle
    const ccBypass = await api.config.get('ccBypassPermissions');
    const ccBypassInput = /** @type {HTMLInputElement} */ ($('#settings-cc-bypass-permissions'));
    if (ccBypassInput) ccBypassInput.checked = !!ccBypass;

    // Load Codex reasoning params
    const reasoningEffort = await api.config.get('codexReasoningEffort');
    const verbosity = await api.config.get('codexVerbosity');
    const reasoningInput = /** @type {HTMLInputElement} */ ($('#settings-reasoning-effort'));
    const verbosityInput = /** @type {HTMLInputElement} */ ($('#settings-verbosity'));
    if (reasoningInput) reasoningInput.value = reasoningEffort || '';
    if (verbosityInput) verbosityInput.value = verbosity || '';

    // Load Codex bypass-permissions toggle
    const codexBypass = await api.config.get('codexBypassPermissions');
    const codexBypassInput = /** @type {HTMLInputElement} */ ($('#settings-codex-bypass-permissions'));
    if (codexBypassInput) codexBypassInput.checked = !!codexBypass;

    // Load stored API keys (shown as password fields, revealable via eye button)
    const anthropicInput = /** @type {HTMLInputElement} */ ($('#settings-key-anthropic'));
    const openaiInput = /** @type {HTMLInputElement} */ ($('#settings-key-openai'));
    const storedAnthropicKey = await api.config.getApiKey('anthropic');
    const storedOpenaiKey = await api.config.getApiKey('openai');
    if (anthropicInput) anthropicInput.value = storedAnthropicKey || '';
    if (openaiInput) openaiInput.value = storedOpenaiKey || '';

    settingsModal.classList.remove('hidden');

    // Show app version
    const versionEl = document.getElementById('settings-app-version');
    if (versionEl) {
        const version = await api.app.getVersion();
        versionEl.textContent = version ? `v${version}` : '';
    }

    // Load debug launch config previews
    loadDebugPreviews();
}

async function loadDebugPreviews() {
    const claudePreview = /** @type {HTMLElement} */ (document.getElementById('debug-claude-config'));
    const codexPreview = /** @type {HTMLElement} */ (document.getElementById('debug-codex-config'));

    try {
        const claudeConfig = await api.tools.getLaunchPreview('claude-code');
        if (claudeConfig && claudePreview) {
            const display = {
                bin: claudeConfig.bin,
                args: claudeConfig.args,
                env: Object.fromEntries(
                    Object.entries(claudeConfig.env).map(([k, v]) =>
                        [k, k.includes('KEY') || k.includes('TOKEN') ? String(v).slice(0, 8) + '***' : v]
                    )
                ),
            };
            claudePreview.textContent = JSON.stringify(display, null, 2);
        } else if (claudePreview) {
            claudePreview.textContent = '未配置或工具不可用';
        }
    } catch (e) {
        if (claudePreview) claudePreview.textContent = '获取失败: ' + e;
    }

    try {
        const codexConfig = await api.tools.getLaunchPreview('codex');
        if (codexConfig && codexPreview) {
            const display = {
                bin: codexConfig.bin,
                args: codexConfig.args,
                env: Object.fromEntries(
                    Object.entries(codexConfig.env).map(([k, v]) =>
                        [k, k.includes('KEY') || k.includes('TOKEN') ? String(v).slice(0, 8) + '***' : v]
                    )
                ),
            };
            codexPreview.textContent = JSON.stringify(display, null, 2);
        } else if (codexPreview) {
            codexPreview.textContent = '未配置或工具不可用';
        }
    } catch (e) {
        if (codexPreview) codexPreview.textContent = '获取失败: ' + e;
    }
}

// ===== Account: balance, recharge, usage logs =====
const accountState = {
    quotaPerUnit: 500000,
    currencySymbol: '$',
    selectedAmount: 0,
    payMethod: 'alipay',
    logsPage: 1,
    logsPageSize: 20,
    logsHasMore: false,
};

/** Convert raw quota units to a display currency string. */
function formatQuota(/** @type {number} */ quota) {
    if (typeof quota !== 'number' || isNaN(quota)) return '--';
    const usd = quota / (accountState.quotaPerUnit || 500000);
    return `${accountState.currencySymbol}${usd.toFixed(2)}`;
}

/** Refresh the compact balance shown in the sidebar user area. */
async function refreshSidebarAccount() {
    const nameEl = $('#account-username');
    const balEl = $('#account-balance');
    try {
        const loggedIn = await api.auth.isLoggedIn();
        if (!loggedIn) {
            if (nameEl) nameEl.textContent = '未登录';
            if (balEl) balEl.textContent = '余额 --';
            return;
        }
        const res = await api.account.getBalance();
        if (res?.success) {
            if (res.quotaPerUnit) accountState.quotaPerUnit = res.quotaPerUnit;
            if (nameEl) nameEl.textContent = res.username || 'TokenWave 用户';
            if (balEl) balEl.textContent = `余额 ${formatQuota(res.quota)}`;
        } else {
            if (balEl) balEl.textContent = '余额 --';
        }
    } catch {
        if (balEl) balEl.textContent = '余额 --';
    }
}

function setupAccount() {
    $('#btn-close-account')?.addEventListener('click', closeAccount);
    $('#account-overlay')?.addEventListener('click', closeAccount);

    // Tab switching
    document.querySelectorAll('.account-tab').forEach((tab) => {
        tab.addEventListener('click', () => switchAccountTab(/** @type {HTMLElement} */(tab).dataset.tab || 'recharge'));
    });

    // Amount presets
    document.querySelectorAll('.account-amount-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const amount = Number(/** @type {HTMLElement} */(btn).dataset.amount || 0);
            accountState.selectedAmount = amount;
            const input = /** @type {HTMLInputElement} */ ($('#account-amount-input'));
            if (input) input.value = String(amount);
            document.querySelectorAll('.account-amount-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePricePreview();
        });
    });

    const amountInput = /** @type {HTMLInputElement} */ ($('#account-amount-input'));
    amountInput?.addEventListener('input', () => {
        accountState.selectedAmount = Number(amountInput.value || 0);
        document.querySelectorAll('.account-amount-btn').forEach(b => b.classList.remove('active'));
        updatePricePreview();
    });

    // 支付渠道选择
    document.querySelectorAll('.account-pay-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            accountState.payMethod = /** @type {HTMLElement} */(btn).dataset.method || 'alipay';
            document.querySelectorAll('.account-pay-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updatePricePreview(); // 渠道倍率不同，重新计算实付金额
        });
    });

    $('#btn-recharge-submit')?.addEventListener('click', submitRecharge);
    $('#btn-qr-back')?.addEventListener('click', resetRechargeForm);
    $('#btn-qr-open-browser')?.addEventListener('click', () => {
        if (qrState.payLink) api.account.openPayLink(qrState.payLink);
    });
    $('#btn-logs-refresh')?.addEventListener('click', () => { accountState.logsPage = 1; loadLogs(); });
    $('#btn-logs-prev')?.addEventListener('click', () => {
        if (accountState.logsPage > 1) { accountState.logsPage--; loadLogs(); }
    });
    $('#btn-logs-next')?.addEventListener('click', () => {
        if (accountState.logsHasMore) { accountState.logsPage++; loadLogs(); }
    });
}

async function openAccount() {
    const loggedIn = await api.auth.isLoggedIn();
    if (!loggedIn) {
        alert('请先登录 TokenWave 账号');
        return;
    }
    const modal = $('#account-modal');
    modal?.classList.remove('hidden');
    switchAccountTab('recharge');
    accountState.selectedAmount = 0;
    const amountInput = /** @type {HTMLInputElement} */ ($('#account-amount-input'));
    if (amountInput) amountInput.value = '';
    document.querySelectorAll('.account-amount-btn').forEach(b => b.classList.remove('active'));
    const priceEl = $('#account-price-preview');
    if (priceEl) priceEl.textContent = '--';
    const msgEl = $('#account-recharge-msg');
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'account-msg'; }
    resetRechargeForm();
    await loadAccountBalance();
}

function closeAccount() {
    stopOrderPolling();
    $('#account-modal')?.classList.add('hidden');
}

function switchAccountTab(/** @type {string} */ tab) {
    document.querySelectorAll('.account-tab').forEach((t) => {
        t.classList.toggle('active', /** @type {HTMLElement} */(t).dataset.tab === tab);
    });
    $('#account-panel-recharge')?.classList.toggle('hidden', tab !== 'recharge');
    $('#account-panel-logs')?.classList.toggle('hidden', tab !== 'logs');
    if (tab === 'logs') { stopOrderPolling(); resetRechargeForm(); accountState.logsPage = 1; loadLogs(); }
}

async function loadAccountBalance() {
    const balEl = $('#account-modal-balance');
    const nameEl = $('#account-modal-username');
    const usedEl = $('#account-modal-used');
    if (balEl) balEl.textContent = '加载中...';
    try {
        const res = await api.account.getBalance();
        if (!res?.success) {
            if (balEl) balEl.textContent = '获取失败';
            return;
        }
        if (res.quotaPerUnit) accountState.quotaPerUnit = res.quotaPerUnit;
        if (balEl) balEl.textContent = formatQuota(res.quota);
        if (nameEl) nameEl.textContent = res.username || '';
        if (usedEl) usedEl.textContent = `已用 ${formatQuota(res.usedQuota)}`;
    } catch (err) {
        if (balEl) balEl.textContent = '获取失败';
    }
}

async function submitRecharge() {
    const msgEl = $('#account-recharge-msg');
    const btn = /** @type {HTMLButtonElement} */ ($('#btn-recharge-submit'));
    const amount = accountState.selectedAmount;
    if (!amount || amount <= 0) {
        if (msgEl) { msgEl.textContent = '请输入有效的充值数量'; msgEl.className = 'account-msg error'; }
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '正在创建订单...'; }
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'account-msg'; }
    try {
        const res = await api.account.createPayment(amount, accountState.payMethod);
        if (!res?.success) {
            if (msgEl) { msgEl.textContent = `创建订单失败: ${res?.error || '未知错误'}`; msgEl.className = 'account-msg error'; }
            return;
        }
        // Stripe：网关返回托管 checkout 链接，直接在系统浏览器打开。
        if (res.browserOnly) {
            await api.account.openPayLink(res.payLink);
            if (msgEl) {
                msgEl.textContent = '已在浏览器中打开 Stripe 支付页面，完成后请点击余额刷新。';
                msgEl.className = 'account-msg success';
            }
            return;
        }
        await showQrView(res);
    } catch (err) {
        if (msgEl) { msgEl.textContent = `创建订单失败: ${err}`; msgEl.className = 'account-msg error'; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '前往支付'; }
    }
}

// ===== 扫码支付：二维码渲染 + 订单轮询 =====
const qrState = {
    orderNo: null,
    payLink: null,
    pollTimer: null,
    deadline: 0,
};

/** 展示二维码视图，渲染二维码并启动轮询。 */
async function showQrView(/** @type {any} */ pay) {
    qrState.orderNo = pay.orderNo || null;
    qrState.payLink = pay.payLink || null;

    const view = $('#account-qr-view');
    const presets = $('#account-amount-presets');
    const custom = document.querySelector('.account-amount-custom');
    const payMethods = document.querySelector('.account-pay-methods');
    const priceRow = document.querySelector('.account-price-row');
    const submitBtn = $('#btn-recharge-submit');
    // 隐藏表单，露出二维码视图
    [presets, custom, payMethods, priceRow, submitBtn].forEach(el => el?.classList.add('hidden'));
    view?.classList.remove('hidden');

    const amountEl = $('#account-qr-amount');
    const priceTxt = $('#account-price-preview')?.textContent || '';
    if (amountEl) amountEl.textContent = priceTxt && priceTxt !== '--' ? priceTxt : `数量 ${accountState.selectedAmount}`;

    const statusEl = $('#account-qr-status');
    const maskEl = $('#account-qr-mask');
    maskEl?.classList.add('hidden');
    if (statusEl) { statusEl.textContent = '等待支付中...'; statusEl.className = 'account-qr-status'; }

    // 渲染二维码：优先用 qr.alipay.com 内容，缺失则回退到 payLink
    const qrText = pay.qrContent || pay.payLink;
    const canvas = /** @type {HTMLCanvasElement} */ ($('#account-qr-canvas'));
    if (canvas && qrText) {
        try {
            await QRCode.toCanvas(canvas, qrText, { width: 240, margin: 1 });
        } catch {
            if (statusEl) { statusEl.textContent = '二维码生成失败，请点击下方按钮在浏览器支付'; statusEl.className = 'account-qr-status error'; }
        }
    }

    startOrderPolling();
}

/** 每 2 秒轮询订单状态，最多 5 分钟。 */
function startOrderPolling() {
    stopOrderPolling();
    if (!qrState.orderNo) return;
    qrState.deadline = Date.now() + 5 * 60 * 1000;
    qrState.pollTimer = setInterval(async () => {
        if (Date.now() > qrState.deadline) {
            stopOrderPolling();
            const statusEl = $('#account-qr-status');
            if (statusEl) { statusEl.textContent = '二维码已超时，请返回重新发起'; statusEl.className = 'account-qr-status error'; }
            return;
        }
        try {
            const res = await api.account.queryOrder(qrState.orderNo);
            if (res?.paid) {
                stopOrderPolling();
                onPaymentSuccess();
            }
        } catch { /* 忽略单次失败，继续轮询 */ }
    }, 2000);
}

function stopOrderPolling() {
    if (qrState.pollTimer) { clearInterval(qrState.pollTimer); qrState.pollTimer = null; }
}

/** 支付成功：打勾遮罩 + 刷新余额，2 秒后回到充值表单。 */
function onPaymentSuccess() {
    const statusEl = $('#account-qr-status');
    const maskEl = $('#account-qr-mask');
    if (maskEl) { maskEl.textContent = '✓'; maskEl.classList.remove('hidden'); }
    if (statusEl) { statusEl.textContent = '支付成功！正在刷新余额...'; statusEl.className = 'account-qr-status success'; }
    loadAccountBalance();
    refreshSidebarAccount();
    setTimeout(() => { resetRechargeForm(); }, 2200);
}

/** 关闭二维码视图，恢复充值表单。 */
function resetRechargeForm() {
    stopOrderPolling();
    qrState.orderNo = null;
    qrState.payLink = null;
    $('#account-qr-view')?.classList.add('hidden');
    $('#account-amount-presets')?.classList.remove('hidden');
    document.querySelector('.account-amount-custom')?.classList.remove('hidden');
    document.querySelector('.account-pay-methods')?.classList.remove('hidden');
    document.querySelector('.account-price-row')?.classList.remove('hidden');
    $('#btn-recharge-submit')?.classList.remove('hidden');
}

let pricePreviewTimer = null;
/** Debounced fetch of the real money charged for the selected quantity. */
function updatePricePreview() {
    const el = $('#account-price-preview');
    const amount = accountState.selectedAmount;
    if (!el) return;
    if (!amount || amount <= 0) { el.textContent = '--'; return; }
    el.textContent = '计算中...';
    if (pricePreviewTimer) clearTimeout(pricePreviewTimer);
    pricePreviewTimer = setTimeout(async () => {
        try {
            const res = await api.account.getPrice(amount, accountState.payMethod);
            if (res?.success && res.price != null) {
                el.textContent = `${accountState.currencySymbol}${res.price}`;
            } else {
                el.textContent = res?.error || '--';
            }
        } catch {
            el.textContent = '--';
        }
    }, 350);
}

const LOG_TYPE_LABELS = { 1: '充值', 2: '消费', 3: '管理', 4: '系统', 5: '错误' };

async function loadLogs() {
    const body = $('#account-logs-body');
    const statusEl = $('#account-logs-status');
    const pageEl = $('#account-logs-page');
    if (body) body.innerHTML = '<tr><td colspan="9" class="account-logs-empty">加载中...</td></tr>';
    if (pageEl) pageEl.textContent = `第 ${accountState.logsPage} 页`;
    try {
        const res = await api.account.getLogs(accountState.logsPage, accountState.logsPageSize);
        if (!res?.success) {
            if (body) body.innerHTML = `<tr><td colspan="9" class="account-logs-empty">获取失败: ${res?.error || ''}</td></tr>`;
            return;
        }
        const items = res.items || [];
        accountState.logsHasMore = items.length >= accountState.logsPageSize;
        if (statusEl) statusEl.textContent = `共 ${res.total ?? items.length} 条`;
        if (!items.length) {
            if (body) body.innerHTML = '<tr><td colspan="9" class="account-logs-empty">暂无记录</td></tr>';
            return;
        }
        if (body) body.innerHTML = items.map(renderLogRow).join('');
    } catch (err) {
        if (body) body.innerHTML = `<tr><td colspan="9" class="account-logs-empty">获取失败: ${err}</td></tr>`;
    }
}

function renderLogRow(/** @type {any} */ log) {
    const ts = log.created_at ?? log.created_time;
    const time = ts ? new Date(ts * 1000).toLocaleString('zh-CN') : '--';
    const type = LOG_TYPE_LABELS[log.type] || String(log.type ?? '--');
    const model = escapeHtml(log.model_name || '--');

    const pt = Number(log.prompt_tokens || 0);
    const ct = Number(log.completion_tokens || 0);
    const cache = Number(log.cache_tokens || 0);
    // prompt_tokens 含缓存部分，未命中输入 = 总输入 - 缓存
    const freshIn = Math.max(pt - cache, 0);

    // 输入列：显示「未命中（总输入）」，鼠标悬停给出明细
    const inTitle = `总输入 ${fmtNum(pt)} = 未命中 ${fmtNum(freshIn)} + 缓存 ${fmtNum(cache)}`;
    const inCell = pt
        ? `<span title="${inTitle}">${fmtNum(freshIn)}<span class="log-dim">/${fmtNum(pt)}</span></span>`
        : '--';

    // 缓存列：缓存 token 数 + 折扣比例
    let cacheCell = '--';
    if (cache > 0) {
        const ratioTxt = typeof log.cache_ratio === 'number'
            ? ` <span class="log-dim">×${log.cache_ratio}</span>` : '';
        cacheCell = `<span title="缓存命中 ${fmtNum(cache)} tokens，按 ${log.cache_ratio ?? '?'} 倍计费">${fmtNum(cache)}${ratioTxt}</span>`;
    } else if (pt > 0) {
        cacheCell = '<span class="log-dim">0</span>';
    }

    const outCell = ct ? fmtNum(ct) : '--';

    // 命中率 = 缓存 / 总输入
    let hitCell = '--';
    if (pt > 0) {
        const rate = (cache / pt) * 100;
        const cls = rate >= 50 ? 'log-hit-high' : (rate > 0 ? 'log-hit-mid' : 'log-hit-low');
        hitCell = `<span class="${cls}">${rate.toFixed(0)}%</span>`;
    }

    // 耗时：优先显示首字延迟(ttft)，否则总耗时(use_time)
    let timeCell = '--';
    if (typeof log.ttft === 'number' && log.ttft >= 0) {
        timeCell = `<span title="首字延迟">${(log.ttft / 1000).toFixed(1)}s</span>`;
    } else if (typeof log.use_time === 'number' && log.use_time > 0) {
        timeCell = `<span title="总耗时">${log.use_time}s</span>`;
    }

    const quota = (log.type === 2 && typeof log.quota === 'number') ? formatQuota(log.quota) : '--';

    // 模型 tooltip 附带推理强度/请求路径等元信息
    const metaBits = [];
    if (log.reasoning_effort) metaBits.push(`推理:${log.reasoning_effort}`);
    if (log.model_ratio) metaBits.push(`倍率:${log.model_ratio}`);
    if (log.request_path) metaBits.push(log.request_path);
    const modelTitle = escapeHtml([log.model_name || '', ...metaBits].filter(Boolean).join(' · '));

    return `<tr>`
        + `<td>${time}</td>`
        + `<td>${type}</td>`
        + `<td class="log-model" title="${modelTitle}">${model}</td>`
        + `<td class="log-num">${inCell}</td>`
        + `<td class="log-num">${cacheCell}</td>`
        + `<td class="log-num">${outCell}</td>`
        + `<td class="log-num">${hitCell}</td>`
        + `<td class="log-num">${timeCell}</td>`
        + `<td class="log-num">${quota}</td>`
        + `</tr>`;
}

/** 千分位格式化，便于阅读大 token 数。 */
function fmtNum(/** @type {number} */ n) {
    if (typeof n !== 'number' || isNaN(n)) return '0';
    return n.toLocaleString('en-US');
}

// ===== File Explorer =====
function setupFileExplorer() {
    const toggleBtn = document.getElementById('btn-toggle-explorer');
    toggleBtn?.addEventListener('click', () => {
        fileExplorer.classList.toggle('collapsed');
        if (!fileExplorer.classList.contains('collapsed') && state.currentCwd) {
            loadFileTree(state.currentCwd);
        }
    });

    // Right-click on empty space in the tree → act on the explorer root.
    fileTree.addEventListener('contextmenu', (e) => {
        if (/** @type {HTMLElement} */ (e.target)?.closest('.tree-item')) return;
        e.preventDefault();
        if (explorerRoot) showTreeContextMenu(e, null);
    });

    // Dismiss the context menu on any outside click, scroll, or Escape.
    document.addEventListener('click', closeTreeContextMenu);
    document.addEventListener('contextmenu', (e) => {
        if (!(/** @type {HTMLElement} */ (e.target)?.closest('#file-tree'))) closeTreeContextMenu();
    });
    window.addEventListener('blur', closeTreeContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTreeContextMenu(); });
}

// Tracks which directory paths are currently expanded, so a refresh after a
// create/delete/rename/move doesn't collapse the whole tree.
const expandedDirs = new Set();
// Root directory currently shown in the explorer (used by blank-area actions).
let explorerRoot = '';
// Monotonic token: guards against two concurrent loadFileTree() calls both
// clearing and appending, which would render duplicate entries.
let fileTreeLoadToken = 0;

async function loadFileTree(/** @type {string} */ dirPath) {
    if (!dirPath || fileExplorer.classList.contains('collapsed')) return;
    explorerRoot = dirPath;

    const parts = dirPath.replace(/\\/g, '/').split('/');
    explorerPath.textContent = parts.slice(-2).join('/');
    explorerPath.title = dirPath;

    const token = ++fileTreeLoadToken;
    const entries = await api.fs.readDir(dirPath);
    // A newer load started while we awaited — let it win, discard this render.
    if (token !== fileTreeLoadToken) return;
    fileTree.innerHTML = '';
    await renderTreeEntries(fileTree, entries);
}

// Re-read and re-render a directory's children in place, preserving the
// expand/collapse state of everything else in the tree.
async function refreshDir(/** @type {string} */ dirPath) {
    // Root: full reload (expandedDirs is honored during re-render).
    if (dirPath === explorerRoot) {
        await loadFileTree(explorerRoot);
        return;
    }
    const childrenEl = fileTree.querySelector(`.tree-children[data-dir="${cssEscape(dirPath)}"]`);
    if (!childrenEl) return;
    const subEntries = await api.fs.readDir(dirPath);
    childrenEl.innerHTML = '';
    await renderTreeEntries(childrenEl, subEntries);
}

function cssEscape(/** @type {string} */ s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/["\\]/g, '\\$&');
}

async function renderTreeEntries(/** @type {HTMLElement} */ container, /** @type {any[]} */ entries) {
    for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.setAttribute('data-path', entry.path);
        item.setAttribute('data-dir', entry.isDirectory ? '1' : '0');
        item.setAttribute('draggable', 'true');
        item.innerHTML = `<span class="icon">${entry.isDirectory ? '📂' : '📄'}</span><span class="tree-label">${escapeHtml(entry.name)}</span>`;

        attachDragHandlers(item, entry);
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTreeContextMenu(e, entry);
        });

        if (entry.isDirectory) {
            const wrapper = document.createElement('div');
            const children = document.createElement('div');
            children.className = 'tree-children';
            children.setAttribute('data-dir', entry.path);

            const isExpanded = expandedDirs.has(entry.path);
            children.style.display = isExpanded ? 'block' : 'none';
            if (isExpanded) {
                const subEntries = await api.fs.readDir(entry.path);
                await renderTreeEntries(children, subEntries);
            }

            item.addEventListener('click', async () => {
                const open = children.style.display !== 'none';
                if (open) {
                    children.style.display = 'none';
                    expandedDirs.delete(entry.path);
                } else {
                    if (!children.childElementCount) {
                        const subEntries = await api.fs.readDir(entry.path);
                        await renderTreeEntries(children, subEntries);
                    }
                    children.style.display = 'block';
                    expandedDirs.add(entry.path);
                }
            });

            wrapper.appendChild(item);
            wrapper.appendChild(children);
            container.appendChild(wrapper);
        } else {
            item.addEventListener('click', () => {
                openFileInEditor(entry.path, entry.name);
            });
            container.appendChild(item);
        }
    }
}

// ===== Custom dialogs & toast =====
// Lightweight in-app replacements for window.prompt/alert/confirm so the
// file-tree flows match the app's dark UI instead of native OS chrome.

function dialogBackdrop() {
    const back = document.createElement('div');
    back.className = 'app-dialog-backdrop';
    return back;
}

/**
 * Themed text-input dialog. Resolves to the trimmed string, or null if the
 * user cancels (Esc / backdrop / 取消).
 * @returns {Promise<string|null>}
 */
function promptDialog(/** @type {string} */ title, /** @type {string} */ initial = '', /** @type {string} */ okText = '确定') {
    return new Promise((resolve) => {
        const back = dialogBackdrop();
        back.innerHTML = `
      <div class="app-dialog">
        <div class="app-dialog-title">${escapeHtml(title)}</div>
        <input class="app-dialog-input" type="text" value="${escapeHtml(initial)}" />
        <div class="app-dialog-actions">
          <button class="app-dialog-btn cancel">取消</button>
          <button class="app-dialog-btn primary">${escapeHtml(okText)}</button>
        </div>
      </div>`;
        document.body.appendChild(back);
        const input = /** @type {HTMLInputElement} */ (back.querySelector('.app-dialog-input'));
        const done = (/** @type {string|null} */ v) => { back.remove(); resolve(v); };
        input.focus();
        input.select();
        back.querySelector('.cancel')?.addEventListener('click', () => done(null));
        back.querySelector('.primary')?.addEventListener('click', () => {
            const v = input.value.trim();
            done(v || null);
        });
        back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { const v = input.value.trim(); done(v || null); }
            else if (e.key === 'Escape') done(null);
        });
    });
}

/** Themed confirm dialog. Resolves true/false. */
function confirmDialog(/** @type {string} */ message, /** @type {boolean} */ danger = false) {
    return new Promise((resolve) => {
        const back = dialogBackdrop();
        back.innerHTML = `
      <div class="app-dialog">
        <div class="app-dialog-message">${escapeHtml(message)}</div>
        <div class="app-dialog-actions">
          <button class="app-dialog-btn cancel">取消</button>
          <button class="app-dialog-btn ${danger ? 'danger' : 'primary'}">确定</button>
        </div>
      </div>`;
        document.body.appendChild(back);
        const done = (/** @type {boolean} */ v) => { back.remove(); resolve(v); };
        /** @type {HTMLElement} */ (back.querySelector('.cancel'))?.focus();
        back.querySelector('.cancel')?.addEventListener('click', () => done(false));
        back.querySelector('.app-dialog-btn:not(.cancel)')?.addEventListener('click', () => done(true));
        back.addEventListener('mousedown', (e) => { if (e.target === back) done(false); });
        back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    });
}

let toastTimer = null;
/** Brief non-blocking notification at the bottom of the window. */
function toast(/** @type {string} */ message, /** @type {'info'|'error'} */ kind = 'info') {
    let el = document.getElementById('app-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'app-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `app-toast show ${kind}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'app-toast'; }, 2200);
}

// ===== File Tree: context menu =====
let treeMenuEl = null;

function closeTreeContextMenu() {
    if (treeMenuEl) {
        treeMenuEl.remove();
        treeMenuEl = null;
    }
}

// Show the right-click menu for a tree entry. `entry` is null when the user
// right-clicks empty space (act on the explorer root).
function showTreeContextMenu(/** @type {MouseEvent} */ e, /** @type {any} */ entry) {
    closeTreeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'tree-context-menu';

    // The directory in which "new file/folder" should be created:
    // the entry itself if it's a folder, else its parent, else the root.
    const targetDir = entry
        ? (entry.isDirectory ? entry.path : parentDir(entry.path))
        : explorerRoot;

    /** @type {Array<{label:string, danger?:boolean, sep?:boolean, action:()=>void}>} */
    const items = [
        { label: '📄 新建文件', action: () => createEntryFlow(targetDir, false) },
        { label: '📁 新建文件夹', action: () => createEntryFlow(targetDir, true) },
    ];
    if (entry) {
        items.push({ label: '✏️ 重命名', action: () => renameEntryFlow(entry) });
        items.push({ label: '🗑️ 删除', danger: true, action: () => deleteEntryFlow(entry) });
    }
    // Path/terminal utilities operate on the target directory (entry's folder,
    // or the explorer root for blank-area clicks).
    items.push({ label: '⬛ 在终端中打开此目录', sep: true, action: () => openDirInTerminal(targetDir) });
    items.push({ label: '📋 复制路径', action: () => copyPath(entry ? entry.path : explorerRoot) });

    for (const it of items) {
        const row = document.createElement('div');
        row.className = 'tree-menu-item' + (it.danger ? ' danger' : '') + (it.sep ? ' has-sep' : '');
        row.textContent = it.label;
        row.addEventListener('click', () => {
            closeTreeContextMenu();
            it.action();
        });
        menu.appendChild(row);
    }

    document.body.appendChild(menu);
    // Position, keeping the menu inside the viewport.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = Math.min(e.clientX, window.innerWidth - mw - 8);
    const y = Math.min(e.clientY, window.innerHeight - mh - 8);
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${Math.max(4, y)}px`;
    treeMenuEl = menu;
}

function parentDir(/** @type {string} */ p) {
    const norm = p.replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    return idx > 0 ? norm.slice(0, idx) : norm;
}

// Open a new terminal tab rooted at `dir`.
async function openDirInTerminal(/** @type {string} */ dir) {
    if (!dir) return;
    try {
        const sessionId = await api.pty.create('terminal', dir);
        // Set the cwd first so the new tab records it and activateTab() refreshes
        // the explorer to this dir. (createTab → activateTab already reloads the
        // tree; calling loadFileTree again here caused a concurrent double-render.)
        state.currentCwd = dir;
        createTab('terminal', 'Terminal', '⬛', sessionId);
    } catch (err) {
        toast(`打开终端失败: ${err}`, 'error');
    }
}

async function copyPath(/** @type {string} */ p) {
    if (!p) return;
    try {
        await navigator.clipboard.writeText(p);
        toast('已复制路径');
    } catch {
        toast('复制失败', 'error');
    }
}

// ===== File Tree: operations =====
async function createEntryFlow(/** @type {string} */ dir, /** @type {boolean} */ isDir) {
    const name = await promptDialog(isDir ? '新建文件夹' : '新建文件', '', '创建');
    if (name == null) return;
    const res = isDir
        ? await api.fs.createDir(dir, name)
        : await api.fs.createFile(dir, name);
    if (!res?.success) {
        toast(res?.error || '创建失败', 'error');
        return;
    }
    expandedDirs.add(dir);
    await refreshDir(dir);
    if (!isDir && res.path) openFileInEditor(res.path, name);
}

async function renameEntryFlow(/** @type {any} */ entry) {
    const newName = await promptDialog('重命名', entry.name, '重命名');
    if (newName == null || newName === entry.name) return;
    const res = await api.fs.rename(entry.path, newName);
    if (!res?.success) {
        toast(res?.error || '重命名失败', 'error');
        return;
    }
    // Keep open editor tabs consistent with the renamed file.
    updateTabsForPath(entry.path, res.path, newName, entry.isDirectory);
    if (entry.isDirectory) {
        if (expandedDirs.delete(entry.path)) expandedDirs.add(res.path);
    }
    await refreshDir(parentDir(entry.path));
}

async function deleteEntryFlow(/** @type {any} */ entry) {
    const kind = entry.isDirectory ? '文件夹' : '文件';
    if (!(await confirmDialog(`确定删除${kind}「${entry.name}」吗？此操作不可撤销。`, true))) return;
    const res = await api.fs.delete(entry.path);
    if (!res?.success) {
        toast(res?.error || '删除失败', 'error');
        return;
    }
    closeTabsUnderPath(entry.path, entry.isDirectory);
    expandedDirs.delete(entry.path);
    await refreshDir(parentDir(entry.path));
}

// When a file/dir is renamed or moved, fix up any open editor tabs so their
// filePath and title stay correct (and dirty edits aren't silently orphaned).
function updateTabsForPath(/** @type {string} */ oldPath, /** @type {string} */ newPath, /** @type {string} */ newName, /** @type {boolean} */ isDir) {
    for (const tab of state.tabs) {
        if (tab.kind !== 'editor' || !tab.filePath) continue;
        if (isDir) {
            if (tab.filePath.startsWith(oldPath + '/') || tab.filePath.startsWith(oldPath + '\\')) {
                tab.filePath = newPath + tab.filePath.slice(oldPath.length);
            }
        } else if (tab.filePath === oldPath) {
            tab.filePath = newPath;
            tab.toolName = newName;
            const titleEl = tab.tabElement.querySelector('.tab-title');
            if (titleEl) titleEl.textContent = newName;
        }
    }
}

// Close editor tabs whose file was deleted (or lived under a deleted folder).
function closeTabsUnderPath(/** @type {string} */ targetPath, /** @type {boolean} */ isDir) {
    for (const tab of [...state.tabs]) {
        if (tab.kind !== 'editor' || !tab.filePath) continue;
        const match = isDir
            ? (tab.filePath === targetPath || tab.filePath.startsWith(targetPath + '/') || tab.filePath.startsWith(targetPath + '\\'))
            : tab.filePath === targetPath;
        if (match) {
            tab.editor?.destroy();
            tab.wrapper.remove();
            tab.tabElement.remove();
            const idx = state.tabs.indexOf(tab);
            if (idx !== -1) state.tabs.splice(idx, 1);
            if (state.activeTabId === tab.id) state.activeTabId = null;
        }
    }
    if (!state.activeTabId && state.tabs.length) activateTab(state.tabs[state.tabs.length - 1].id);
    if (!state.tabs.length) {
        tabBarEmpty.classList.remove('hidden');
        emptyState.classList.remove('hidden');
    }
}

// ===== File Tree: drag & drop move =====
let dragSrc = null;

function attachDragHandlers(/** @type {HTMLElement} */ item, /** @type {any} */ entry) {
    item.addEventListener('dragstart', (e) => {
        dragSrc = entry;
        e.dataTransfer?.setData('text/plain', entry.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
    });
    item.addEventListener('dragend', () => {
        dragSrc = null;
        document.querySelectorAll('.tree-item.drop-into').forEach(el => el.classList.remove('drop-into'));
    });

    if (!entry.isDirectory) return; // only folders are drop targets
    item.addEventListener('dragover', (e) => {
        if (!dragSrc || dragSrc.path === entry.path) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        item.classList.add('drop-into');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-into'));
    item.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drop-into');
        const src = dragSrc;
        dragSrc = null;
        if (!src || src.path === entry.path) return;
        const res = await api.fs.move(src.path, entry.path);
        if (!res?.success) {
            toast(res?.error || '移动失败', 'error');
            return;
        }
        updateTabsForPath(src.path, res.path, src.name, src.isDirectory);
        if (src.isDirectory && expandedDirs.delete(src.path)) expandedDirs.add(res.path);
        expandedDirs.add(entry.path);
        await refreshDir(parentDir(src.path));
        await refreshDir(entry.path);
    });
}

// ===== Remote Config Sync =====
function checkRemoteConfigOnStartup() {
    api.app.checkRemoteConfig().then((/** @type {any} */ result) => {
        if (!result.hasChanges || !result.changes.length) return;

        const modal = /** @type {HTMLElement} */ ($('#config-update-modal'));
        const changesList = /** @type {HTMLElement} */ ($('#config-changes-list'));
        if (!modal || !changesList) return;

        // Build changes table
        let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
        html += '<tr style="opacity:0.6;"><th style="text-align:left;padding:6px 8px;">配置项</th><th style="text-align:left;padding:6px 8px;">当前值</th><th style="text-align:left;padding:6px 8px;"></th><th style="text-align:left;padding:6px 8px;">新值</th></tr>';
        for (const change of result.changes) {
            html += `<tr style="border-top:1px solid rgba(128,128,128,0.2);">`;
            html += `<td style="padding:6px 8px;font-weight:500;">${change.key}</td>`;
            html += `<td style="padding:6px 8px;opacity:0.6;text-decoration:line-through;">${change.oldValue}</td>`;
            html += `<td style="padding:6px 8px;">→</td>`;
            html += `<td style="padding:6px 8px;color:#3fb950;font-weight:600;">${change.newValue}</td>`;
            html += `</tr>`;
        }
        html += '</table>';
        changesList.innerHTML = html;

        // Show modal
        modal.classList.remove('hidden');

        const closeModal = () => modal.classList.add('hidden');

        $('#btn-close-config-modal')?.addEventListener('click', closeModal);
        $('#btn-dismiss-config')?.addEventListener('click', closeModal);
        modal.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

        $('#btn-apply-config')?.addEventListener('click', async () => {
            await api.app.applyRemoteConfig(result.remoteConfig);
            closeModal();
        });
    }).catch(() => { /* ignore startup config check failures */ });
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', init);
