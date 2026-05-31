import { BrowserWindow, session } from 'electron';
import * as https from 'https';
import { ConfigStore } from './config-store';

const ROUTER_BASE_URL = 'https://api.dshub.top';
const ACCESS_TOKEN_KEY = 'tokenwave-access-token';
const USER_ID_KEY = 'tokenwave-user-id';

/** How often (ms) to poll cookies and check login status */
const POLL_INTERVAL = 3000;

export interface LoginResult {
    success: boolean;
    accessToken?: string;
    username?: string;
    error?: string;
}

/**
 * Module 1: AuthManager
 * Handles TokenWave login/registration via embedded WebView (Electron BrowserWindow).
 * After successful login, obtains and stores the accessToken.
 *
 * Detection strategy: poll the WebView's session cookies every few seconds.
 * When cookies exist, try calling GET /api/user/token.
 * If the API returns an accessToken, login is confirmed — no need to
 * guess based on URL navigation (which is unreliable with SPAs and can
 * fire false-positives when the user simply browses to the home page).
 */
export class AuthManager {
    private configStore: ConfigStore;
    private loginWindow: BrowserWindow | null = null;

    constructor(configStore: ConfigStore) {
        this.configStore = configStore;
    }

    /**
     * Open a WebView window for TokenWave login/registration.
     * Returns a Promise that resolves when login is successful or the window is closed.
     */
    async loginViaWebView(parentWindow: BrowserWindow): Promise<LoginResult> {
        // Prevent multiple login windows
        if (this.loginWindow && !this.loginWindow.isDestroyed()) {
            this.loginWindow.focus();
            return { success: false, error: '登录窗口已打开' };
        }

        return new Promise<LoginResult>((resolve) => {
            let resolved = false;
            let pollTimer: ReturnType<typeof setInterval> | null = null;

            const safeResolve = (result: LoginResult) => {
                if (resolved) return;
                resolved = true;
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                resolve(result);
            };

            // 1. Create isolated session (does not pollute main window)
            const authSession = session.fromPartition('auth-4router');

            // 2. Create child BrowserWindow.
            //
            // Not modal: a modal child blocks every event on the parent
            // (including its own close button on macOS), so if anything in
            // the login flow stalls the user has no way out without
            // force-quitting. Keeping it as a regular child window lets the
            // user close either window independently.
            this.loginWindow = new BrowserWindow({
                width: 900,
                height: 700,
                parent: parentWindow,
                modal: false,
                title: '登录 TokenWave',
                autoHideMenuBar: true,
                minimizable: true,
                closable: true,
                webPreferences: {
                    session: authSession,
                    nodeIntegration: false,
                    contextIsolation: true,
                },
            });

            // 3. Load the login page
            this.loginWindow.loadURL(`${ROUTER_BASE_URL}/login`);

            // Inject a floating "取消登录" button into the page on every
            // navigation so the user always has an in-page escape hatch
            // even if the OS chrome misbehaves. The button signals back
            // via console.log('__TW_CANCEL_LOGIN__'), which we listen
            // for on the webContents below.
            const injectCancelButton = () => {
                if (!this.loginWindow || this.loginWindow.isDestroyed()) return;
                this.loginWindow.webContents.executeJavaScript(`
                    (() => {
                        if (document.getElementById('__tw_cancel_login__')) return;
                        const btn = document.createElement('button');
                        btn.id = '__tw_cancel_login__';
                        btn.textContent = '✕ 取消登录';
                        btn.style.cssText = [
                            'position:fixed','top:14px','right:14px','z-index:2147483647',
                            'padding:8px 14px','border-radius:8px','border:none',
                            'background:rgba(20,20,20,0.85)','color:#fff','font-size:13px',
                            'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
                            'cursor:pointer','box-shadow:0 4px 12px rgba(0,0,0,0.25)',
                            'backdrop-filter:blur(8px)',
                        ].join(';');
                        btn.onmouseenter = () => { btn.style.background = 'rgba(220,53,69,0.9)'; };
                        btn.onmouseleave = () => { btn.style.background = 'rgba(20,20,20,0.85)'; };
                        btn.onclick = () => { console.log('__TW_CANCEL_LOGIN__'); };
                        document.body.appendChild(btn);
                    })();
                `).catch(() => { /* page may have navigated mid-injection — re-injects on next did-finish-load */ });
            };
            this.loginWindow.webContents.on('did-finish-load', injectCancelButton);
            this.loginWindow.webContents.on('console-message', (_event, _level, message) => {
                if (message.includes('__TW_CANCEL_LOGIN__')) {
                    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
                        this.loginWindow.close();
                    }
                }
            });

            // 4. Poll cookies to detect login success
            //    Every POLL_INTERVAL ms, grab cookies → try /api/user/token.
            //    This works regardless of SPA navigation, 2FA, OAuth, etc.
            let polling = false; // guard against overlapping polls
            const pollLoginStatus = async () => {
                if (resolved || polling) return;
                polling = true;
                try {
                    const cookies = await authSession.cookies.get({ url: ROUTER_BASE_URL });
                    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    console.log('[AuthManager] poll: cookies count =', cookies.length,
                        ', names =', cookies.map(c => c.name).join(', '));
                    if (!cookieHeader) {
                        console.log('[AuthManager] poll: no cookies yet, skipping');
                        return;
                    }

                    console.log('[AuthManager] poll: trying fetchAccessToken...');
                    const userId = await this.readUserIdFromWebView();
                    console.log('[AuthManager] poll: userId from localStorage =', userId);
                    if (!userId) {
                        console.log('[AuthManager] poll: no userId yet, skipping');
                        return;
                    }
                    const accessToken = await this.fetchAccessToken(cookieHeader, userId);
                    console.log('[AuthManager] poll: got accessToken =', accessToken?.slice(0, 8) + '...');

                    // Success — store and close
                    this.configStore.setApiKey(ACCESS_TOKEN_KEY, accessToken);
                    this.configStore.setApiKey(USER_ID_KEY, userId);

                    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
                        this.loginWindow.close();
                    }
                    safeResolve({ success: true, accessToken });
                } catch (err: any) {
                    // Not logged in yet — ignore and keep polling
                    console.log('[AuthManager] poll: not logged in yet, error =', err?.message);
                } finally {
                    polling = false;
                }
            };

            pollTimer = setInterval(pollLoginStatus, POLL_INTERVAL);

            // 5. User closes window = cancel login
            this.loginWindow.on('closed', () => {
                this.loginWindow = null;
                safeResolve({ success: false, error: '用户取消登录' });
            });
        });
    }

    /**
     * In-app login with username/password — no WebView, no keychain.
     * Posts to /api/user/login, captures the session cookie + user id from
     * the response, then reuses fetchAccessToken to obtain the accessToken.
     * Stores the same keys as the WebView path, so isLoggedIn / provision /
     * account all keep working unchanged.
     */
    async loginWithCredentials(username: string, password: string): Promise<LoginResult> {
        try {
            const { json, cookies } = await this.httpPostJson('/api/user/login', { username, password });
            if (!json?.success) {
                return { success: false, error: json?.message || '登录失败' };
            }
            const userId = json?.data?.id != null ? String(json.data.id) : null;
            if (!userId) {
                return { success: false, error: '登录响应缺少用户 ID' };
            }
            const accessToken = await this.fetchAccessToken(cookies, userId);
            this.configStore.setApiKey(ACCESS_TOKEN_KEY, accessToken);
            this.configStore.setApiKey(USER_ID_KEY, userId);
            return { success: true, accessToken, username: json?.data?.username || username };
        } catch (err: any) {
            return { success: false, error: err?.message || '登录失败' };
        }
    }

    /**
     * In-app registration. Posts to /api/user/register, then auto-logs-in
     * with the same credentials on success so the user lands straight in.
     */
    async register(username: string, password: string): Promise<LoginResult> {
        try {
            const { json } = await this.httpPostJson('/api/user/register', {
                username,
                password,
                password2: password,
            });
            if (!json?.success) {
                return { success: false, error: json?.message || '注册失败' };
            }
            // Registration succeeded → log in immediately to fetch the token.
            return this.loginWithCredentials(username, password);
        } catch (err: any) {
            return { success: false, error: err?.message || '注册失败' };
        }
    }

    /**
     * POST JSON to the router. Resolves with the parsed body and the
     * concatenated Set-Cookie header (name=value; ...) for session reuse.
     */
    private httpPostJson(
        path: string,
        body: Record<string, any>
    ): Promise<{ statusCode: number; json: any; cookies: string }> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${ROUTER_BASE_URL}${path}`);
            const payload = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let raw = '';
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                    // Strip cookie attributes (Path, HttpOnly, ...) — keep name=value.
                    const setCookie = res.headers['set-cookie'] || [];
                    const cookies = setCookie
                        .map((c) => c.split(';')[0])
                        .join('; ');
                    try {
                        resolve({ statusCode: res.statusCode || 0, json: JSON.parse(raw), cookies });
                    } catch {
                        reject(new Error('解析响应失败'));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('请求超时'));
            });
            req.write(payload);
            req.end();
        });
    }

    /**
     * Get the stored accessToken.
     */
    getAccessToken(): string | null {
        return this.configStore.getApiKey(ACCESS_TOKEN_KEY);
    }

    /**
     * Get the stored New-API user id (required as `New-Api-User` request header).
     */
    getUserId(): string | null {
        return this.configStore.getApiKey(USER_ID_KEY);
    }

    /**
     * Check if user is logged in (has a valid accessToken stored).
     */
    isLoggedIn(): boolean {
        return this.configStore.hasApiKey(ACCESS_TOKEN_KEY);
    }

    /**
     * Logout: clear the stored accessToken.
     */
    logout(): void {
        this.configStore.setApiKey(ACCESS_TOKEN_KEY, '');
        this.configStore.setApiKey(USER_ID_KEY, '');
    }

    /**
     * Read New-API user.id from the WebView's localStorage.
     * New-API stores logged-in user info as JSON under key "user".
     * Returns null if the key is missing or unparseable (i.e. user not logged in yet).
     */
    private async readUserIdFromWebView(): Promise<string | null> {
        if (!this.loginWindow || this.loginWindow.isDestroyed()) return null;
        try {
            const raw = await this.loginWindow.webContents.executeJavaScript(
                `localStorage.getItem('user')`,
                true
            );
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const id = parsed?.id;
            return id != null ? String(id) : null;
        } catch {
            return null;
        }
    }

    /**
     * Use session cookies to call GET /api/user/token.
     * This endpoint generates/returns the accessToken.
     * Throws on failure (not logged in, network error, etc.).
     */
    private fetchAccessToken(cookieHeader: string, userId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${ROUTER_BASE_URL}/api/user/token`);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'New-Api-User': userId,
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    console.log('[AuthManager] fetchAccessToken response: status =', res.statusCode,
                        ', body =', body.slice(0, 300));
                    try {
                        const data = JSON.parse(body);
                        if (data.success && data.data) {
                            resolve(data.data); // accessToken string
                        } else {
                            reject(new Error(data.message || '获取 AccessToken 失败'));
                        }
                    } catch {
                        reject(new Error('解析响应失败'));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`网络请求失败: ${err.message}`));
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('请求超时'));
            });

            req.end();
        });
    }
}
