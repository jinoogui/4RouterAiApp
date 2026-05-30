import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ToolManager } from './tool-manager';

export type SessionTool = 'claude-code' | 'codex';

export interface SessionMeta {
    id: string;
    tool: SessionTool;
    title: string;
    cwd: string;
    updatedAt: number; // epoch ms
}

const PLACEHOLDER_TITLE = '未命名会话';
const MAX_HEADER_LINES = 60; // only scan the head of each jsonl
const TITLE_MAX = 80;

/**
 * Reads session metadata from the bundled CLIs' isolated config dirs.
 * Never reads whole files — only streams the first lines to extract
 * {id, title, cwd, updatedAt}. Resilient: a malformed file is skipped,
 * a missing directory yields no entries.
 */
export class SessionStore {
    constructor(private toolManager: ToolManager) {}

    // File-level cache: only re-parse a jsonl when its mtime changes, so
    // reopening the panel stays cheap even with thousands of sessions.
    private cache = new Map<string, { mtimeMs: number; meta: SessionMeta | null }>();

    private get claudeProjectsDir(): string {
        return path.join(this.toolManager.getAppDataDir(), 'claude-home', 'projects');
    }

    private get codexSessionsDir(): string {
        return path.join(this.toolManager.getAppDataDir(), 'codex-home', 'sessions');
    }

    async listSessions(): Promise<SessionMeta[]> {
        const seen = new Set<string>();
        const [claude, codex] = await Promise.all([
            this.scanClaude(seen).catch(() => [] as SessionMeta[]),
            this.scanCodex(seen).catch(() => [] as SessionMeta[]),
        ]);
        // Drop cache entries for files that no longer exist.
        for (const key of this.cache.keys()) {
            if (!seen.has(key)) this.cache.delete(key);
        }
        return [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * Stat a file and return its cached meta when mtime is unchanged;
     * otherwise run `parse` and store the result keyed by mtime.
     */
    private async cachedParse(
        filePath: string,
        seen: Set<string>,
        parse: (mtimeMs: number) => Promise<SessionMeta | null>
    ): Promise<SessionMeta | null> {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        seen.add(filePath);
        const hit = this.cache.get(filePath);
        if (hit && hit.mtimeMs === mtimeMs) return hit.meta;
        const meta = await parse(mtimeMs);
        this.cache.set(filePath, { mtimeMs, meta });
        return meta;
    }

    // ── Claude: projects/<cwd-encoded>/<sessionId>.jsonl ──
    private async scanClaude(seen: Set<string>): Promise<SessionMeta[]> {
        const root = this.claudeProjectsDir;
        if (!fs.existsSync(root)) return [];
        const out: SessionMeta[] = [];

        for (const projectDir of fs.readdirSync(root, { withFileTypes: true })) {
            if (!projectDir.isDirectory()) continue;
            const dirPath = path.join(root, projectDir.name);
            let files: string[];
            try {
                files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
            } catch {
                continue;
            }
            for (const file of files) {
                const full = path.join(dirPath, file);
                try {
                    const meta = await this.cachedParse(full, seen, (mtimeMs) =>
                        this.parseClaudeFile(full, mtimeMs)
                    );
                    if (meta) out.push(meta);
                } catch {
                    /* skip unreadable file */
                }
            }
        }
        return out;
    }

    private async parseClaudeFile(filePath: string, mtimeMs: number): Promise<SessionMeta | null> {
        const id = path.basename(filePath, '.jsonl');
        let cwd = '';
        let title = '';

        await this.eachHeaderLine(filePath, (obj) => {
            if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
            if (!title && obj.type === 'user') {
                title = extractText(obj.message?.content);
            }
            return !!(cwd && title); // stop early once both found
        });

        return {
            id,
            tool: 'claude-code',
            title: cleanTitle(title),
            cwd,
            updatedAt: mtimeMs,
        };
    }

    // ── Codex: sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl ──
    private async scanCodex(seen: Set<string>): Promise<SessionMeta[]> {
        const root = this.codexSessionsDir;
        if (!fs.existsSync(root)) return [];
        const out: SessionMeta[] = [];

        for (const file of walkJsonl(root)) {
            try {
                const meta = await this.cachedParse(file, seen, (mtimeMs) =>
                    this.parseCodexFile(file, mtimeMs)
                );
                if (meta) out.push(meta);
            } catch {
                /* skip */
            }
        }
        return out;
    }

    private async parseCodexFile(filePath: string, mtimeMs: number): Promise<SessionMeta | null> {
        let id = '';
        let cwd = '';
        let title = '';

        await this.eachHeaderLine(filePath, (obj) => {
            const p = obj.payload || {};
            if (obj.type === 'session_meta') {
                if (typeof p.id === 'string') id = p.id;
                if (typeof p.cwd === 'string') cwd = p.cwd;
            }
            // The cleanest title source is the `event_msg / user_message`
            // record — its `message` field is the user's raw input, free of
            // the <environment_context> / <permissions> blocks that wrap the
            // `response_item` user messages.
            if (!title && obj.type === 'event_msg' && p.type === 'user_message') {
                if (typeof p.message === 'string') title = p.message;
            }
            return !!(id && title);
        });

        if (!id) {
            // fall back to the UUID embedded in the filename
            const m = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (m) id = m[1];
        }
        if (!id) return null;

        return {
            id,
            tool: 'codex',
            title: cleanTitle(title),
            cwd,
            updatedAt: mtimeMs,
        };
    }

    /**
     * Stream the first MAX_HEADER_LINES of a jsonl file, parsing each line
     * to JSON and passing it to `visit`. Stops early when visit returns true.
     */
    private async eachHeaderLine(
        filePath: string,
        visit: (obj: any) => boolean
    ): Promise<void> {
        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let n = 0;
        try {
            for await (const line of rl) {
                if (n++ >= MAX_HEADER_LINES) break;
                if (!line.trim()) continue;
                let obj: any;
                try {
                    obj = JSON.parse(line);
                } catch {
                    continue;
                }
                if (visit(obj)) break;
            }
        } finally {
            rl.close();
            stream.close();
        }
    }
}

// ── helpers ──

/** Extract plain text from a CLI message `content` (string or block array). */
function extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        for (const b of content) {
            if (b && typeof b === 'object') {
                if (b.type === 'text' && typeof b.text === 'string') return b.text;
                if (b.type === 'input_text' && typeof b.text === 'string') return b.text;
            }
        }
    }
    return '';
}

function cleanTitle(raw: string): string {
    const t = (raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return PLACEHOLDER_TITLE;
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t;
}

/** Recursively yield all rollout-*.jsonl files under a directory. */
function* walkJsonl(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            yield* walkJsonl(full);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
            yield full;
        }
    }
}
