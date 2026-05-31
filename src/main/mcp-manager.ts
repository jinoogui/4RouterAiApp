import * as fs from 'fs';
import * as path from 'path';
import { ToolManager } from './tool-manager';

// ── Where Claude Code reads MCP servers from ──
// Claude Code under CLAUDE_CONFIG_DIR has known issues loading MCP from some
// files (GitHub #42217 / #48448). Keep the target in one place so it can be
// switched if `.mcp.json` turns out not to be honoured in a given CC version.
const CLAUDE_MCP_TARGET = { file: '.mcp.json', jsonRoot: 'mcpServers' };

export type McpTransport = 'stdio' | 'http';

export interface McpServer {
    name: string;
    transport: McpTransport;
    command?: string;            // stdio
    args?: string[];             // stdio
    url?: string;                // http
    headers?: Record<string, string>; // http
    env?: Record<string, string>;
    startupTimeoutMs?: number;   // Codex only
    targets: ('claude-code' | 'codex')[];
    enabled: boolean;
    raw?: string;                // Codex-only unparseable section (read-only)
}

export interface McpResult {
    success: boolean;
    error?: string;
    partial?: string[];          // targets that failed when others succeeded
}

/**
 * McpManager — manages MCP server entries for both bundled CLIs.
 *
 * Claude Code: JSON at <claude-home>/.mcp.json under { mcpServers: {...} }.
 * Codex:       TOML sections [mcp_servers.<name>] in <codex-home>/config.toml.
 *
 * The two formats differ, so servers are kept in one internal McpServer shape
 * and converted on write. Disabled servers live in a single sidecar JSON so
 * the "disabled" state survives without relying on either CLI's parser.
 */
export class McpManager {
    constructor(private readonly toolManager: ToolManager) {}

    private appData(): string {
        return this.toolManager.getAppDataDir();
    }
    private claudeMcpPath(): string {
        return path.join(this.appData(), 'claude-home', CLAUDE_MCP_TARGET.file);
    }
    private codexConfigPath(): string {
        return path.join(this.appData(), 'codex-home', 'config.toml');
    }
    private disabledPath(): string {
        return path.join(this.appData(), 'tokenwave-mcp-disabled.json');
    }

    // ── Public API ──

    /** Aggregate enabled servers from both CLI files plus the disabled sidecar. */
    list(): McpServer[] {
        const byName = new Map<string, McpServer>();

        // Claude (.mcp.json)
        const claude = this.readClaude();
        for (const [name, entry] of Object.entries(claude)) {
            const s = fromClaudeEntry(name, entry);
            const existing = byName.get(name);
            if (existing) existing.targets.push('claude-code');
            else byName.set(name, { ...s, targets: ['claude-code'], enabled: true });
        }

        // Codex (config.toml)
        const codex = this.readCodexSections();
        for (const [name, s] of codex) {
            const existing = byName.get(name);
            if (existing) {
                existing.targets.push('codex');
                if (s.raw && !existing.raw) existing.raw = s.raw;
            } else {
                byName.set(name, { ...s, targets: ['codex'], enabled: true });
            }
        }

        // Disabled sidecar
        const disabled = this.readDisabled();
        for (const [name, rec] of Object.entries(disabled)) {
            if (byName.has(name)) continue; // an enabled copy wins
            byName.set(name, { ...rec.server, enabled: false });
        }

        return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    add(server: McpServer): McpResult {
        const name = sanitizeMcpName(server.name);
        if (!name) return { success: false, error: '名称非法（仅允许字母/数字/._-）' };
        if (this.list().some((s) => s.name === name)) {
            return { success: false, error: `已存在同名服务器：${name}` };
        }
        return this.writeServer({ ...server, name }, null);
    }

    update(oldName: string, server: McpServer): McpResult {
        const name = sanitizeMcpName(server.name);
        if (!name) return { success: false, error: '名称非法（仅允许字母/数字/._-）' };
        if (name !== oldName && this.list().some((s) => s.name === name)) {
            return { success: false, error: `已存在同名服务器：${name}` };
        }
        return this.writeServer({ ...server, name }, oldName);
    }

    /** Remove a server from every CLI file and the disabled sidecar. */
    remove(name: string): McpResult {
        try {
            this.removeFromClaude(name);
            this.removeFromCodex(name);
            const disabled = this.readDisabled();
            if (disabled[name]) { delete disabled[name]; this.writeDisabled(disabled); }
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '删除失败' };
        }
    }

    /** Enable → write to its targets' files; disable → move to the sidecar. */
    toggle(name: string, enabled: boolean): McpResult {
        const server = this.list().find((s) => s.name === name);
        if (!server) return { success: false, error: '未找到该服务器' };
        if (server.enabled === enabled) return { success: true };

        try {
            if (enabled) {
                const disabled = this.readDisabled();
                const rec = disabled[name];
                if (!rec) return { success: false, error: '禁用记录缺失' };
                delete disabled[name];
                this.writeDisabled(disabled);
                return this.writeServer(rec.server, null);
            } else {
                this.removeFromClaude(name);
                this.removeFromCodex(name);
                const disabled = this.readDisabled();
                disabled[name] = { server: { ...server, enabled: false } };
                this.writeDisabled(disabled);
                return { success: true };
            }
        } catch (err: any) {
            return { success: false, error: err?.message || '切换失败' };
        }
    }

    /** Write a server to each of its targets; track per-target failures. */
    private writeServer(server: McpServer, oldName: string | null): McpResult {
        // http is not supported by Codex — reject the combination early.
        if (server.transport === 'http' && server.targets.includes('codex')) {
            return { success: false, error: 'Codex 暂不支持远程 HTTP MCP，请取消勾选 Codex' };
        }
        const failed: string[] = [];

        // Remove the old name everywhere first (handles rename + target changes).
        try {
            if (oldName) { this.removeFromClaude(oldName); this.removeFromCodex(oldName); }
            else { this.removeFromClaude(server.name); this.removeFromCodex(server.name); }
        } catch { /* best-effort cleanup */ }

        if (server.targets.includes('claude-code')) {
            try { this.upsertClaude(server); } catch { failed.push('claude-code'); }
        }
        if (server.targets.includes('codex')) {
            try { this.upsertCodex(server); } catch { failed.push('codex'); }
        }

        if (failed.length && failed.length === server.targets.length) {
            return { success: false, error: '写入失败', partial: failed };
        }
        return failed.length ? { success: true, partial: failed } : { success: true };
    }

    // ── Claude (.mcp.json) ──

    private readClaude(): Record<string, any> {
        const file = this.claudeMcpPath();
        if (!fs.existsSync(file)) return {};
        try {
            const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const root = json?.[CLAUDE_MCP_TARGET.jsonRoot];
            return root && typeof root === 'object' ? root : {};
        } catch {
            return {};
        }
    }

    /** Read the whole file, mutate only mcpServers, write back atomically. */
    private mutateClaude(fn: (servers: Record<string, any>) => void): void {
        const file = this.claudeMcpPath();
        let json: any = {};
        if (fs.existsSync(file)) {
            json = JSON.parse(fs.readFileSync(file, 'utf-8')); // refuse to clobber unreadable
        }
        if (!json[CLAUDE_MCP_TARGET.jsonRoot] || typeof json[CLAUDE_MCP_TARGET.jsonRoot] !== 'object') {
            json[CLAUDE_MCP_TARGET.jsonRoot] = {};
        }
        fn(json[CLAUDE_MCP_TARGET.jsonRoot]);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(json, null, 2));
    }

    private upsertClaude(server: McpServer): void {
        this.mutateClaude((servers) => { servers[server.name] = toClaudeEntry(server); });
    }
    private removeFromClaude(name: string): void {
        if (!fs.existsSync(this.claudeMcpPath())) return;
        this.mutateClaude((servers) => { delete servers[name]; });
    }

    // ── Codex (config.toml [mcp_servers.*]) ──

    private readCodexSections(): Map<string, McpServer> {
        const file = this.codexConfigPath();
        if (!fs.existsSync(file)) return new Map();
        try { return parseCodexMcp(fs.readFileSync(file, 'utf-8')); }
        catch { return new Map(); }
    }

    private upsertCodex(server: McpServer): void {
        const file = this.codexConfigPath();
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
        const next = writeCodexMcp(existing, server.name, server);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, next);
    }
    private removeFromCodex(name: string): void {
        const file = this.codexConfigPath();
        if (!fs.existsSync(file)) return;
        const next = writeCodexMcp(fs.readFileSync(file, 'utf-8'), name, null);
        writeAtomic(file, next);
    }

    // ── Disabled sidecar ──

    private readDisabled(): Record<string, { server: McpServer }> {
        const file = this.disabledPath();
        if (!fs.existsSync(file)) return {};
        try { return JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; }
        catch { return {}; }
    }
    private writeDisabled(data: Record<string, { server: McpServer }>): void {
        const file = this.disabledPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(data, null, 2));
    }
}

// ── Helpers (module scope) ──

/** MCP names become a TOML section name / JSON key, so keep them strict. */
function sanitizeMcpName(name: string): string | null {
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed.length > 64) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
    return trimmed;
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
function writeAtomic(file: string, content: string): void {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
}

function toClaudeEntry(s: McpServer): any {
    if (s.transport === 'http') {
        const e: any = { type: 'http', url: s.url };
        if (s.headers && Object.keys(s.headers).length) e.headers = s.headers;
        return e;
    }
    const e: any = { command: s.command, args: s.args || [] };
    if (s.env && Object.keys(s.env).length) e.env = s.env;
    return e;
}

function fromClaudeEntry(name: string, entry: any): McpServer {
    const isHttp = entry?.type === 'http' || entry?.type === 'sse' || (!!entry?.url && !entry?.command);
    return {
        name,
        transport: isHttp ? 'http' : 'stdio',
        command: entry?.command,
        args: Array.isArray(entry?.args) ? entry.args : undefined,
        url: entry?.url,
        headers: entry?.headers,
        env: entry?.env,
        targets: [],
        enabled: true,
    };
}

// ── Minimal TOML handling for [mcp_servers.*] only ──
// We do NOT parse the whole TOML document. We locate the line range of each
// mcp section (a header line `[mcp_servers.<name>]` or `[mcp_servers.<name>.env]`
// up to the next `[` header or EOF) and operate only on those ranges. Every
// other line in the file is preserved verbatim.

const MCP_HEADER_RE = /^\s*\[mcp_servers\.([^.\]]+)(\.env)?\]\s*$/;

/** Group the file's lines into mcp-section blocks keyed by server name. */
function collectMcpBlocks(lines: string[]): Map<string, { start: number; end: number }> {
    const blocks = new Map<string, { start: number; end: number }>();
    let current: { name: string; start: number } | null = null;

    const close = (endExclusive: number) => {
        if (!current) return;
        const prev = blocks.get(current.name);
        // Extend an existing block (covers the .env subsection too).
        blocks.set(current.name, {
            start: prev ? prev.start : current.start,
            end: endExclusive,
        });
        current = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const header = lines[i].match(MCP_HEADER_RE);
        const isAnyHeader = /^\s*\[/.test(lines[i]);
        if (header) {
            const name = header[1].replace(/^["']|["']$/g, '');
            if (current && current.name !== name) close(i);
            if (!current) current = { name, start: i };
        } else if (isAnyHeader && current) {
            close(i); // a non-mcp section header ends the current block
        }
    }
    if (current) close(lines.length);
    return blocks;
}

/** Parse mcp sections into McpServer entries (best-effort; unparseable → raw). */
function parseCodexMcp(toml: string): Map<string, McpServer> {
    const lines = toml.split('\n');
    const blocks = collectMcpBlocks(lines);
    const result = new Map<string, McpServer>();

    for (const [name, range] of blocks) {
        const body = lines.slice(range.start, range.end);
        const server: McpServer = { name, transport: 'stdio', targets: [], enabled: true };
        const env: Record<string, string> = {};
        let inEnv = false;
        let ok = true;

        for (const line of body) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            if (MCP_HEADER_RE.test(line)) { inEnv = /\.env\]\s*$/.test(trimmed); continue; }

            const kv = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
            if (!kv) { ok = false; break; }
            const key = kv[1];
            const rawVal = kv[2].trim();

            if (inEnv) { env[key] = parseTomlString(rawVal); continue; }
            if (key === 'command') server.command = parseTomlString(rawVal);
            else if (key === 'args') server.args = parseTomlArray(rawVal);
            else if (key === 'startup_timeout_ms') server.startupTimeoutMs = parseInt(rawVal, 10) || undefined;
            else if (key === 'url') { server.url = parseTomlString(rawVal); server.transport = 'http'; }
            // ignore unknown keys but keep the section parseable
        }

        if (Object.keys(env).length) server.env = env;
        if (!ok || (!server.command && !server.url)) {
            result.set(name, { name, transport: 'stdio', targets: [], enabled: true, raw: body.join('\n') });
        } else {
            result.set(name, server);
        }
    }
    return result;
}

/**
 * Insert/replace/delete one mcp section in a TOML document, leaving every other
 * line untouched. server=null deletes. Returns the new document text.
 */
function writeCodexMcp(toml: string, name: string, server: McpServer | null): string {
    const lines = toml.split('\n');
    const blocks = collectMcpBlocks(lines);
    const range = blocks.get(name);

    const newBlock = server ? toCodexLines(server) : [];

    let out: string[];
    if (range) {
        out = [...lines.slice(0, range.start), ...newBlock, ...lines.slice(range.end)];
    } else if (server) {
        // Append at EOF with a blank-line separator.
        const base = toml.replace(/\s*$/, '');
        out = base ? [base, '', ...newBlock] : [...newBlock];
    } else {
        out = lines;
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
}

/** Serialize one McpServer to TOML lines (stdio only — http is rejected upstream). */
function toCodexLines(s: McpServer): string[] {
    const lines: string[] = [`[mcp_servers.${s.name}]`];
    if (s.command !== undefined) lines.push(`command = ${tomlString(s.command)}`);
    if (s.args && s.args.length) {
        lines.push(`args = [${s.args.map(tomlString).join(', ')}]`);
    }
    if (typeof s.startupTimeoutMs === 'number') {
        lines.push(`startup_timeout_ms = ${s.startupTimeoutMs}`);
    }
    if (s.env && Object.keys(s.env).length) {
        lines.push(`[mcp_servers.${s.name}.env]`);
        for (const [k, v] of Object.entries(s.env)) lines.push(`${k} = ${tomlString(v)}`);
    }
    return lines;
}

// ── tiny TOML scalar helpers ──
function tomlString(v: string): string {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function parseTomlString(raw: string): string {
    const m = raw.match(/^"((?:[^"\\]|\\.)*)"$/) || raw.match(/^'([^']*)'$/);
    if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return raw;
}
function parseTomlArray(raw: string): string[] {
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
    if (!inner.trim()) return [];
    // split on commas not inside quotes
    const parts = inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,]+/g) || [];
    return parts.map((p) => parseTomlString(p.trim()));
}
