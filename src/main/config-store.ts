import { safeStorage } from 'electron';
import Store from 'electron-store';
import * as crypto from 'crypto';

interface ConfigSchema {
    theme: 'dark' | 'light' | 'fruit';
    defaultCwd: string;
    workingDirectories: string[];
    proxy: string;
    encryptedKeys: Record<string, string>;
    /** Random seed used to derive the local AES key. Generated once per install. */
    keySeed: string;
    baseUrls: Record<string, string>;
    models: Record<string, string>;
    codexReasoningEffort: string;
    codexVerbosity: string;
    ccEffortLevel: string;
    fontSize: number;
    fontFamily: string;
    ccBypassPermissions: boolean;
    codexBypassPermissions: boolean;
    firstLaunch: boolean;
    /** Override GitHub repo (owner/repo[/path]) used as the Skills market. */
    skillsMarketRepo: string;
}

const defaults: ConfigSchema = {
    theme: 'light',
    defaultCwd: '',
    workingDirectories: [],
    proxy: '',
    encryptedKeys: {},
    keySeed: '',
    baseUrls: {},
    models: { anthropic: 'opus', openai: 'gpt-5.3-codex' },
    codexReasoningEffort: 'xhigh',
    codexVerbosity: 'high',
    ccEffortLevel: 'high',
    fontSize: 14,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    ccBypassPermissions: false,
    codexBypassPermissions: false,
    firstLaunch: true,
    skillsMarketRepo: '',
};

// AES-256-GCM payload prefix, so we can distinguish our format from legacy
// safeStorage blobs and plain values during migration.
const ENC_PREFIX = 'gcm:';

export class ConfigStore {
    private store: Store<ConfigSchema>;

    constructor() {
        this.store = new Store<ConfigSchema>({
            name: '4routerai-config',
            defaults,
        });
        this.migrateWorkingDirectories();
    }

    // ===== Local key-based encryption (no OS keychain → never prompts) =====

    /** Lazily create and persist a random seed, then derive a 32-byte AES key. */
    private getKey(): Buffer {
        let seed = this.store.get('keySeed');
        if (!seed) {
            seed = crypto.randomBytes(32).toString('hex');
            this.store.set('keySeed', seed);
        }
        // scrypt binds the key to the per-install seed; the static salt is fine
        // here because the seed itself is the secret.
        return crypto.scryptSync(seed, 'tokenwave-kdf-v1', 32);
    }

    /** Encrypt with AES-256-GCM → "gcm:<iv>:<tag>:<ciphertext>" (all base64). */
    private encrypt(plain: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
        const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
    }

    /** Decrypt our "gcm:" format. Throws on tamper/wrong key. */
    private decrypt(payload: string): string {
        const [iv, tag, data] = payload.slice(ENC_PREFIX.length).split(':');
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.getKey(),
            Buffer.from(iv, 'base64')
        );
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(data, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    }

    // One-time migration: seed the new multi-dir list from the legacy single
    // defaultCwd so existing users keep their saved directory.
    private migrateWorkingDirectories(): void {
        const dirs = this.store.get('workingDirectories');
        const legacy = this.store.get('defaultCwd');
        if ((!dirs || dirs.length === 0) && legacy) {
            this.store.set('workingDirectories', [legacy]);
        }
    }

    get(key: string): any {
        // Never expose raw secrets to the renderer.
        if (key === 'encryptedKeys' || key === 'keySeed') return undefined;
        return this.store.get(key as keyof ConfigSchema);
    }

    set(key: string, value: any): void {
        // Protect secret-bearing keys from renderer writes.
        if (key === 'encryptedKeys' || key === 'keySeed') return;
        this.store.set(key as keyof ConfigSchema, value);
    }

    /**
     * Store API key encrypted with a local derived key (AES-256-GCM).
     * No OS keychain involved, so this never triggers a keychain prompt.
     */
    setApiKey(provider: string, key: string): void {
        const encryptedKeys = this.store.get('encryptedKeys', {});
        encryptedKeys[provider] = this.encrypt(key);
        this.store.set('encryptedKeys', encryptedKeys);
    }

    /**
     * Retrieve and decrypt an API key. Transparently migrates legacy values
     * (safeStorage blobs or "plain:") to the new format on first read — the
     * legacy safeStorage path triggers at most ONE final keychain prompt.
     */
    getApiKey(provider: string): string | null {
        const encryptedKeys = this.store.get('encryptedKeys', {});
        const stored = encryptedKeys[provider];
        if (!stored) return null;

        // New format.
        if (stored.startsWith(ENC_PREFIX)) {
            try {
                return this.decrypt(stored);
            } catch {
                return null;
            }
        }

        // Legacy plain value → re-encrypt and return.
        if (stored.startsWith('plain:')) {
            const key = stored.slice(6);
            this.setApiKey(provider, key);
            return key;
        }

        // Legacy safeStorage blob (base64) → decrypt once via keychain, migrate.
        try {
            if (safeStorage.isEncryptionAvailable()) {
                const key = safeStorage.decryptString(Buffer.from(stored, 'base64'));
                this.setApiKey(provider, key); // migrate to local-key format
                return key;
            }
        } catch {
            /* fall through */
        }
        return null;
    }

    hasApiKey(provider: string): boolean {
        const encryptedKeys = this.store.get('encryptedKeys', {});
        return !!encryptedKeys[provider];
    }

    /**
     * Store base URL for a provider's API endpoint.
     */
    setBaseUrl(provider: string, url: string): void {
        const baseUrls = this.store.get('baseUrls', {});
        baseUrls[provider] = url;
        this.store.set('baseUrls', baseUrls);
    }

    /**
     * Get base URL for a provider.
     */
    getBaseUrl(provider: string): string | null {
        const baseUrls = this.store.get('baseUrls', {});
        return baseUrls[provider] || null;
    }

    setModel(provider: string, model: string): void {
        const models = this.store.get('models', {});
        models[provider] = model;
        this.store.set('models', models);
    }

    getModel(provider: string): string | null {
        const models = this.store.get('models', { anthropic: 'opus', openai: 'gpt-5.3-codex' });
        return models[provider] || null;
    }

    isFirstLaunch(): boolean {
        return this.store.get('firstLaunch', true);
    }

    markLaunched(): void {
        this.store.set('firstLaunch', false);
    }
}
