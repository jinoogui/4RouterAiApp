import * as https from 'https';

const ROUTER_BASE_URL = 'https://api.dshub.top';

export interface ProvisionResult {
    success: boolean;
    claudeKey?: string;
    codexKey?: string;
    error?: string;
}

export interface CreateTokenOptions {
    name: string;
    group: string;
    expiredTime?: number;  // -1 = never expire
    unlimitedQuota?: boolean;
}

/**
 * Module 2: KeyProvisioner
 * Independent API Key creation module. Only depends on accessToken.
 * Reusable by any context (e.g., future auto-create keys for new channel groups).
 */
export class KeyProvisioner {
    private readonly baseUrl = ROUTER_BASE_URL;

    /**
     * Core method: Create a set of API Keys (Claude + Codex) using accessToken.
     * Idempotent: reuses existing tokens if they already exist.
     */
    async provisionKeys(accessToken: string, userId: string): Promise<ProvisionResult> {
        try {
            // Create Claude Key (group: AppClaude)
            const claudeKey = await this.createToken(accessToken, userId, {
                name: 'TokenWave-Claude',
                group: 'AppClaude',
                expiredTime: -1,
                unlimitedQuota: true,
            });

            // Create Codex Key (group: AppCodex)
            const codexKey = await this.createToken(accessToken, userId, {
                name: 'TokenWave-Codex',
                group: 'AppCodex',
                expiredTime: -1,
                unlimitedQuota: true,
            });

            return { success: true, claudeKey, codexKey };
        } catch (err: any) {
            return { success: false, error: err?.message || 'Key 创建失败' };
        }
    }

    /**
     * Reusable single token creation method.
     * 1. Search for existing token with same name (idempotent)
     * 2. If exists, return existing key
     * 3. If not, create new token, then search to get the key string
     */
    async createToken(accessToken: string, userId: string, options: CreateTokenOptions): Promise<string> {
        // Step 1: Search for existing token (idempotent)
        const existingKey = await this.findTokenKey(accessToken, userId, options.name);
        if (existingKey) return existingKey;

        // Step 2: Create new token
        const createResult = await this.httpPost('/api/token/', accessToken, userId, {
            name: options.name,
            group: options.group,
            expired_time: options.expiredTime ?? -1,
            remain_quota: 0,
            unlimited_quota: options.unlimitedQuota ?? true,
            model_limits_enabled: false,
            model_limits: '',
            cross_group_retry: false,
        });

        if (!createResult.success) {
            throw new Error(createResult.message || `创建 Token "${options.name}" 失败`);
        }

        // Step 3: Search to get the newly created token's key
        // Small delay to ensure DB write is committed
        await new Promise(r => setTimeout(r, 500));

        const newKey = await this.findTokenKey(accessToken, userId, options.name);
        if (!newKey) {
            throw new Error(`Token "${options.name}" 创建后未能获取 key`);
        }
        return newKey;
    }

    /**
     * Search for a token by name and return its key string.
     */
    private async findTokenKey(accessToken: string, userId: string, tokenName: string): Promise<string | null> {
        const encodedName = encodeURIComponent(tokenName);
        const result = await this.httpGet(
            `/api/token/search?keyword=${encodedName}`,
            accessToken,
            userId
        );

        if (result.success && result.data) {
            // Handle both paginated { items: [...] } and direct array response
            const items = result.data.items || result.data;
            if (Array.isArray(items)) {
                // Exact name match, sort by created_time desc, take latest
                const matched = items
                    .filter((t: any) => t.name === tokenName && t.key)
                    .sort((a: any, b: any) => (b.created_time || 0) - (a.created_time || 0));

                if (matched.length > 0) {
                    return matched[0].key;
                }
            }
        }
        return null;
    }

    /**
     * HTTP GET request with Bearer token authentication.
     */
    private httpGet(path: string, accessToken: string, userId: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}${path}`);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'New-Api-User': userId,
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        reject(new Error(`JSON 解析失败: ${body.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
            req.end();
        });
    }

    /**
     * HTTP POST request with Bearer token authentication.
     */
    private httpPost(path: string, accessToken: string, userId: string, body: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseUrl}${path}`);
            const bodyStr = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'New-Api-User': userId,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    'Accept': 'application/json',
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')); });
            req.write(bodyStr);
            req.end();
        });
    }
}
