import { BrowserWindow, session } from 'electron';
import * as https from 'https';
import { ConfigStore } from './config-store';

const ROUTER_BASE_URL = 'https://4router.net';
const ACCESS_TOKEN_KEY = '4router-access-token';

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
 * Handles 4Router login/registration via embedded WebView (Electron BrowserWindow).
 * After successful login, obtains and stores the accessToken.
 *
 * Detection strategy: poll the WebView's session cookies every few seconds.
 * When cookies exist, try calling GET /api/user/self/token.
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
     * Open a WebView window for 4Router login/registration.
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

            // 2. Create modal child BrowserWindow
            this.loginWindow = new BrowserWindow({
                width: 900,
                height: 700,
                parent: parentWindow,
                modal: true,
                title: '登录 4Router',
                autoHideMenuBar: true,
                webPreferences: {
                    session: authSession,
                    nodeIntegration: false,
                    contextIsolation: true,
                },
            });

            // 3. Load the login page
            this.loginWindow.loadURL(`${ROUTER_BASE_URL}/login`);

            // 4. Poll cookies to detect login success
            //    Every POLL_INTERVAL ms, grab cookies → try /api/user/self/token.
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
                    const accessToken = await this.fetchAccessToken(cookieHeader);
                    console.log('[AuthManager] poll: got accessToken =', accessToken?.slice(0, 8) + '...');

                    // Success — store and close
                    this.configStore.setApiKey(ACCESS_TOKEN_KEY, accessToken);

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
     * Get the stored accessToken.
     */
    getAccessToken(): string | null {
        return this.configStore.getApiKey(ACCESS_TOKEN_KEY);
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
    }

    /**
     * Use session cookies to call GET /api/user/self/token.
     * This endpoint generates/returns the accessToken.
     * Throws on failure (not logged in, network error, etc.).
     */
    private fetchAccessToken(cookieHeader: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${ROUTER_BASE_URL}/api/user/token`);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
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
