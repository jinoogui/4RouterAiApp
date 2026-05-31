import * as https from 'https';
import { app } from 'electron';
import { ConfigStore } from './config-store';
import { McpServer } from './mcp-manager';

const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const GITHUB_API = 'https://api.github.com';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;
const MAX_SKILL_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024; // 1MB per file

// Catalog item surfaced to the renderer for a searchable MCP entry.
export interface McpCatalogItem {
    name: string;
    description: string;
    source: string;              // repository URL or registry
    kind: 'stdio' | 'http';
    package?: string;            // npm package id (stdio)
    command?: string;
    args?: string[];
    url?: string;                // remote (http)
    envKeys?: string[];          // env var names (no values)
}

export interface SkillCatalogItem {
    name: string;                // directory name in the market repo
    description: string;
    repo: string;                // "owner/repo"
    dirPath: string;             // path within the repo
}

export interface SkillFile {
    rel: string;                 // path relative to the skill root
    content: string;
}

/**
 * RegistryClient — all outbound network access for searching/installing
 * extensions lives here. Requests honour the configured proxy and never carry
 * local credentials (GitHub is hit unauthenticated, so callers must handle the
 * 60 req/hour rate limit gracefully).
 */
export class RegistryClient {
    constructor(private readonly configStore: ConfigStore) {}

    private proxy(): string | undefined {
        const p = this.configStore.get('proxy') as string | undefined;
        return p && p.trim() ? p.trim() : undefined;
    }

    /** GET a URL following redirects; resolves the raw body + status. */
    private request(url: string, accept: string, redirects = 0): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const proxy = this.proxy();
            const options: https.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'User-Agent': `TokenWave/${app.getVersion()}`,
                    Accept: accept,
                },
                timeout: TIMEOUT_MS,
            };
            if (proxy) {
                try {
                    const pu = new URL(proxy);
                    options.hostname = pu.hostname;
                    options.port = parseInt(pu.port) || (pu.protocol === 'https:' ? 443 : 80);
                    options.path = url;
                    (options.headers as Record<string, string>)['Host'] = parsed.hostname;
                } catch { /* ignore invalid proxy */ }
            }

            const req = https.request(options, (res) => {
                const status = res.statusCode || 0;
                // follow redirects
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirects >= MAX_REDIRECTS) { reject(new Error('重定向次数过多')); return; }
                    const next = new URL(res.headers.location, url).href;
                    this.request(next, accept, redirects + 1).then(resolve, reject);
                    return;
                }
                let body = '';
                res.on('data', (c: Buffer) => { body += c.toString(); });
                res.on('end', () => resolve({ status, body }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
            req.end();
        });
    }

    private async getJson(url: string): Promise<any> {
        const { status, body } = await this.request(url, 'application/json');
        if (status === 403) throw new Error('GitHub 限流（未认证 60 次/小时），请稍后再试');
        if (status < 200 || status >= 300) throw new Error(`请求失败 (${status})`);
        try { return JSON.parse(body); }
        catch { throw new Error('响应解析失败'); }
    }

    private async getText(url: string): Promise<string> {
        const { status, body } = await this.request(url, 'text/plain');
        if (status < 200 || status >= 300) throw new Error(`请求失败 (${status})`);
        return body;
    }

    // ── MCP (official registry) ──

    /** Search the official MCP registry; returns normalized catalog items. */
    async searchMcp(query: string, limit = 30): Promise<McpCatalogItem[]> {
        const q = (query || '').trim();
        const url = `${MCP_REGISTRY}?limit=${limit}${q ? `&search=${encodeURIComponent(q)}` : ''}`;
        const json = await this.getJson(url);
        const servers: any[] = Array.isArray(json?.servers) ? json.servers : [];
        const items: McpCatalogItem[] = [];
        for (const entry of servers) {
            // The registry wraps the actual record; tolerate both shapes.
            const s = entry?.server || entry;
            const item = parseRegistryServer(s);
            if (item) items.push(item);
        }
        return items;
    }

    /** A bare npm package name → a stdio McpServer (npx -y <pkg>). */
    resolveNpmPackage(pkg: string): McpServer {
        const name = pkg.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '-');
        return { name, transport: 'stdio', command: 'npx', args: ['-y', pkg], targets: [], enabled: true };
    }

    /** A catalog item + chosen targets → an McpServer ready for add(). */
    catalogItemToServer(item: McpCatalogItem, targets: ('claude-code' | 'codex')[]): McpServer {
        const env: Record<string, string> = {};
        for (const k of item.envKeys || []) env[k] = '';
        const base: McpServer = {
            name: item.name.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '-'),
            transport: item.kind,
            targets,
            enabled: true,
            env: Object.keys(env).length ? env : undefined,
        };
        if (item.kind === 'http') base.url = item.url;
        else { base.command = item.command || 'npx'; base.args = item.args || (item.package ? ['-y', item.package] : []); }
        return base;
    }

    // ── Skills (GitHub) ──

    /** List skill directories in a market repo (each dir holding a SKILL.md). */
    async fetchSkillsCatalog(repo: string, basePath = ''): Promise<SkillCatalogItem[]> {
        const { owner, name } = splitRepo(repo);
        const url = `${GITHUB_API}/repos/${owner}/${name}/contents/${basePath.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
        const list = await this.getJson(url);
        if (!Array.isArray(list)) throw new Error('仓库内容读取失败');

        const dirs = list.filter((e: any) => e.type === 'dir');
        const items: SkillCatalogItem[] = [];
        for (const d of dirs) {
            try {
                const inner = await this.getJson(d.url);
                const skillMd = Array.isArray(inner) && inner.find((f: any) => /^SKILL\.md$/i.test(f.name));
                if (!skillMd) continue;
                let description = '';
                try {
                    const md = await this.getText(skillMd.download_url);
                    description = parseFrontmatterField(md, 'description');
                } catch { /* description optional */ }
                items.push({ name: d.name, description, repo: `${owner}/${name}`, dirPath: d.path });
            } catch { /* skip unreadable dir */ }
        }
        return items;
    }

    /** Recursively download a skill directory's text files (bounded). */
    async downloadSkillTree(repo: string, dirPath: string): Promise<SkillFile[]> {
        const { owner, name } = splitRepo(repo);
        const files: SkillFile[] = [];
        const root = dirPath.replace(/\/+$/, '');

        const walk = async (p: string): Promise<void> => {
            if (files.length >= MAX_SKILL_FILES) return;
            const url = `${GITHUB_API}/repos/${owner}/${name}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
            const list = await this.getJson(url);
            if (!Array.isArray(list)) throw new Error('目录读取失败');
            for (const entry of list) {
                if (files.length >= MAX_SKILL_FILES) break;
                if (entry.type === 'dir') {
                    await walk(entry.path);
                } else if (entry.type === 'file') {
                    if (entry.size > MAX_FILE_BYTES) continue;
                    if (isBinaryName(entry.name)) continue;
                    const rel = entry.path.slice(root.length).replace(/^\/+/, '');
                    const content = await this.getText(entry.download_url);
                    files.push({ rel, content });
                }
            }
        };

        await walk(root);
        if (!files.length) throw new Error('该目录下没有可下载的文本文件');
        if (!files.some((f) => /^SKILL\.md$/i.test(f.rel))) {
            throw new Error('该目录不是有效的 Skill（缺少 SKILL.md）');
        }
        return files;
    }
}

// ── Module-level helpers ──

/** Normalize a registry server record into a catalog item (stdio or http). */
function parseRegistryServer(s: any): McpCatalogItem | null {
    if (!s || !s.name) return null;
    const name: string = s.name;
    const description: string = s.description || '';
    const source: string = s.repository?.url || s.repository || 'registry.modelcontextprotocol.io';

    const pkgs: any[] = Array.isArray(s.packages) ? s.packages : [];
    const npm = pkgs.find((p) => p.registry_type === 'npm' || p.registry_name === 'npm');
    if (npm && (npm.identifier || npm.name)) {
        const id = npm.identifier || npm.name;
        const version = npm.version ? `@${npm.version}` : '';
        const envKeys = (npm.environment_variables || npm.env || [])
            .map((e: any) => e?.name).filter(Boolean);
        return {
            name, description, source, kind: 'stdio',
            package: `${id}${version}`,
            command: 'npx',
            args: ['-y', `${id}${version}`],
            envKeys,
        };
    }

    const remotes: any[] = Array.isArray(s.remotes) ? s.remotes : [];
    if (remotes.length && remotes[0].url) {
        return { name, description, source, kind: 'http', url: remotes[0].url };
    }
    return null;
}

/** Parse owner/repo from "owner/repo" or a GitHub URL (tree path optional). */
export function parseGithubUrl(input: string): { repo: string; dirPath: string } {
    const trimmed = (input || '').trim();
    const urlMatch = trimmed.match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/[^/]+\/(.+))?/i);
    const short = trimmed.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
    const m = urlMatch || short;
    if (!m) throw new Error('无法解析 GitHub 地址');
    const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
    const dirPath = (m[3] || '').replace(/\/+$/, '');
    return { repo, dirPath };
}

function splitRepo(repo: string): { owner: string; name: string } {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error('仓库格式应为 owner/repo');
    return { owner, name };
}

function parseFrontmatterField(md: string, field: string): string {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return '';
    const line = m[1].split('\n').find((l) => l.trim().startsWith(field + ':'));
    return line ? line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') : '';
}

function isBinaryName(name: string): boolean {
    return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|wasm)$/i.test(name);
}
