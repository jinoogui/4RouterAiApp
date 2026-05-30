import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigStore } from './config-store';
import { buildSanitizedEnv } from './process-env';

export interface ToolInfo {
    id: string;
    name: string;
    description: string;
    provider: string;
    icon: string;
    envKeyName: string;
    envBaseUrlName: string;
    defaultBaseUrl: string;
    available: boolean;
    version?: string;
    source?: 'bundled' | 'global';
}

export interface LaunchConfig {
    bin: string;
    args: string[];
    env: Record<string, string>;
}

interface ResolvedToolPath {
    path: string;
    source: 'bundled' | 'global';
    launchMode: 'node-script' | 'command';
}

/**
 * Extract user-managed sections from an existing Codex config.toml,
 * filtering out host-controlled keys and sections that 4RouterAi
 * regenerates on every launch.
 */
function preserveUserConfig(existing: string): string {
    // Section headers that the host app fully controls (regenerated each launch).
    const hostSections = new Set([
        '[model_providers.4routerai]',
        '[analytics]',
    ]);
    // Root-level keys that the host app controls.
    const hostRootKeys = new Set([
        'model_provider',
        'model',
        'model_reasoning_effort',
        'model_context_window',
        'model_auto_compact_token_limit',
        'check_for_update_on_startup',
        'model_verbosity',
        'approval_policy',
        'sandbox_mode',
    ]);

    const lines = existing.split('\n');
    const preserved: string[] = [];
    let inHostSection = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect section headers — e.g. [windows], [projects.'...'], [notice]
        if (/^\[.+\]/.test(trimmed)) {
            inHostSection = hostSections.has(trimmed);
            if (!inHostSection) {
                preserved.push(line);
            }
            continue;
        }

        // Inside a host-controlled section → skip the line
        if (inHostSection) continue;

        // Root-level area → filter out host-controlled keys
        const keyMatch = trimmed.match(/^(\w+)\s*=/);
        if (keyMatch && hostRootKeys.has(keyMatch[1])) continue;

        preserved.push(line);
    }

    // Trim leading/trailing blank lines and return with surrounding newlines
    const result = preserved.join('\n').trim();
    return result ? '\n' + result + '\n' : '';
}

export class ToolManager {
    private toolDefinitions: ToolInfo[] = [
        {
            id: 'claude-code',
            name: 'Claude Code',
            description: 'Anthropic 的 AI 编程助手',
            provider: 'anthropic',
            icon: '🟣',
            envKeyName: 'ANTHROPIC_API_KEY',
            envBaseUrlName: 'ANTHROPIC_BASE_URL',
            defaultBaseUrl: 'https://api.anthropic.com',
            available: false,
        },
        {
            id: 'codex',
            name: 'Codex CLI',
            description: 'OpenAI 的命令行编程代理',
            provider: 'openai',
            icon: '🟢',
            envKeyName: 'OPENAI_API_KEY',
            envBaseUrlName: 'OPENAI_BASE_URL',
            defaultBaseUrl: 'https://api.openai.com/v1',
            available: false,
        },
    ];

    constructor(
        private bundledToolsPath: string,
        private configStore: ConfigStore
    ) {
        console.log('[ToolManager] Bundled tools path:', this.bundledToolsPath);
        this.detectTools();
    }

    private detectTools(): void {
        for (const tool of this.toolDefinitions) {
            const result = this.findToolBin(tool.id);
            tool.available = result !== null;
            tool.source = result?.source;
            if (result) {
                console.log(`[ToolManager] ${tool.id}: found at ${result.path} (${result.source})`);
            }

            if (tool.available) {
                try {
                    const pkgDir = path.join(this.bundledToolsPath,
                        tool.id === 'claude-code' ? 'claude-code' : 'codex');
                    const pkgJsonPath = path.join(pkgDir, 'node_modules',
                        tool.id === 'claude-code' ? '@anthropic-ai' : '@openai',
                        tool.id === 'claude-code' ? 'claude-code' : 'codex',
                        'package.json');
                    if (fs.existsSync(pkgJsonPath)) {
                        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                        tool.version = pkg.version;
                    }
                } catch { /* best-effort */ }
            }
        }
    }

    private getToolDir(toolId: string): string {
        return path.join(this.bundledToolsPath, toolId === 'claude-code' ? 'claude-code' : 'codex');
    }

    private getBundledNodeDir(): string {
        return path.join(this.bundledToolsPath, 'node-runtime');
    }

    private getBundledGitDir(): string {
        return path.join(this.bundledToolsPath, 'mingit');
    }

    private getBundledNodeExecutable(): string {
        const exeName = os.platform() === 'win32' ? 'node.exe' : 'node';
        return path.join(this.getBundledNodeDir(), exeName);
    }

    private getBundledNpmCli(): string {
        return path.join(this.getBundledNodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    }

    private getBundledGitBashPath(): string {
        return path.join(this.getBundledGitDir(), 'bin', 'bash.exe');
    }

    private getBundledGitPathEntries(): string[] {
        const gitDir = this.getBundledGitDir();
        return [
            path.join(gitDir, 'cmd'),
            path.join(gitDir, 'bin'),
            path.join(gitDir, 'usr', 'bin'),
            path.join(gitDir, 'mingw64', 'bin'),
        ].filter(entry => fs.existsSync(entry));
    }

    private hasBundledRuntime(): boolean {
        return fs.existsSync(this.getBundledNodeExecutable()) && fs.existsSync(this.getBundledNpmCli());
    }

    /**
     * OS-specific user-data root, used as the parent of the per-tool
     * config directories (claude-home, codex-home, etc.). Mirrors what
     * Electron's `app.getPath('userData')` would return for the host OS,
     * so paths look natural on each platform.
     */
    private getPlatformAppDataDir(): string {
        if (os.platform() === 'win32') {
            return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        }
        if (os.platform() === 'darwin') {
            return path.join(os.homedir(), 'Library', 'Application Support');
        }
        return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    }

    /** TokenWave's per-user data root, used by callers that need to write
        sibling configs alongside claude-home/codex-home (e.g. local-config
        importer copies hooks/MCP files into these dirs). */
    public getAppDataDir(): string {
        return path.join(this.getPlatformAppDataDir(), 'TokenWave');
    }

    /**
     * Where Codex writes generated images for the current session. Co-locates
     * them with the user's project so they're easy to find. Created lazily.
     */
    public getGeneratedImagesDir(cwd: string | null): string {
        const base = (cwd && fs.existsSync(cwd))
            ? cwd
            : path.join(os.homedir(), 'Documents', 'TokenWave');
        return path.join(base, 'generated_images');
    }

    /**
     * Replace $CODEX_HOME/generated_images with a symlink pointing into the
     * user's current project, so Codex's hardcoded output path lands somewhere
     * the user can actually find. Re-creates the link on every launch in case
     * cwd changed since the last session.
     *
     * macOS/Linux use POSIX symlinks. Windows uses a directory junction (does
     * not require admin rights, unlike a real symlink).
     */
    private linkGeneratedImagesToProject(codexHomeDir: string): void {
        const cwd = (this.configStore.get('defaultCwd') as string) || '';
        const target = this.getGeneratedImagesDir(cwd || null);
        const link = path.join(codexHomeDir, 'generated_images');

        try {
            fs.mkdirSync(target, { recursive: true });

            // If the link path already exists, decide whether to keep it.
            if (fs.existsSync(link) || this.isDanglingSymlink(link)) {
                try {
                    const current = fs.readlinkSync(link);
                    if (path.resolve(current) === path.resolve(target)) return; // already correct
                } catch { /* not a symlink — fall through to remove */ }

                // Remove stale link/dir. Refuse if it's a real directory with files
                // (could be from a prior install before this code existed).
                const stat = fs.lstatSync(link);
                if (stat.isSymbolicLink()) {
                    fs.unlinkSync(link);
                } else if (stat.isDirectory()) {
                    const entries = fs.readdirSync(link);
                    if (entries.length === 0) {
                        fs.rmdirSync(link);
                    } else {
                        console.warn(`[ToolManager] ${link} is a non-empty real directory; leaving it alone`);
                        return;
                    }
                }
            }

            const symlinkType = os.platform() === 'win32' ? 'junction' : 'dir';
            fs.symlinkSync(target, link, symlinkType);
            console.log(`[ToolManager] Linked ${link} → ${target}`);
        } catch (err) {
            console.warn('[ToolManager] Failed to link generated_images:', err);
            // Non-fatal — Codex will still work, just write to the default location.
        }
    }

    private isDanglingSymlink(p: string): boolean {
        try {
            const stat = fs.lstatSync(p);
            return stat.isSymbolicLink();
        } catch {
            return false;
        }
    }

    private getBundledToolScript(toolId: string): string | null {
        const toolDir = this.getToolDir(toolId);
        switch (toolId) {
            case 'claude-code': {
                const pkgDir = path.join(toolDir, 'node_modules', '@anthropic-ai', 'claude-code');
                const candidates = [
                    path.join(pkgDir, 'cli.js'),
                    path.join(pkgDir, 'cli-wrapper.cjs'),
                ];
                return candidates.find(c => fs.existsSync(c)) || null;
            }
            case 'codex':
                return path.join(toolDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
            default:
                return null;
        }
    }

    private resolveClaudeGitBashPath(): string | null {
        if (os.platform() !== 'win32') {
            return null;
        }

        const bundledBashPath = this.getBundledGitBashPath();
        if (fs.existsSync(bundledBashPath)) {
            return bundledBashPath;
        }

        const explicitPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;
        if (explicitPath && fs.existsSync(explicitPath)) {
            return explicitPath;
        }

        const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
        const pathEntries = (process.env[pathKey] || process.env.PATH || '')
            .split(';')
            .map(entry => entry.trim())
            .filter(Boolean);

        const candidates = [
            ...pathEntries.map(entry => path.join(entry, 'bash.exe')),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
            path.join(process.env.LocalAppData || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Git', 'bin', 'bash.exe'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private buildRuntimeEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
        const env = { ...extraEnv };
        if (!this.hasBundledRuntime()) {
            return env;
        }

        const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
        const pathSep = os.platform() === 'win32' ? ';' : ':';
        const currentPath = process.env[pathKey] || process.env.PATH || '';
        env[pathKey] = [
            this.getBundledNodeDir(),
            ...this.getBundledGitPathEntries(),
            currentPath,
        ].filter(Boolean).join(pathSep);
        return env;
    }

    private findToolBin(toolId: string): ResolvedToolPath | null {
        const isWin = os.platform() === 'win32';
        const binExt = isWin ? '.cmd' : '';
        let binName: string;
        const toolDir = this.getToolDir(toolId);

        switch (toolId) {
            case 'claude-code':
                binName = 'claude' + binExt;
                break;
            case 'codex':
                binName = 'codex' + binExt;
                break;
            default:
                return null;
        }

        const bundledScript = this.getBundledToolScript(toolId);
        if (bundledScript && this.hasBundledRuntime() && fs.existsSync(bundledScript)) {
            return { path: bundledScript, source: 'bundled', launchMode: 'node-script' };
        }

        const globalBin = isWin
            ? path.join(process.env.APPDATA || '', 'npm', binName)
            : path.join('/usr/local/bin', binName);
        if (fs.existsSync(globalBin)) {
            return { path: globalBin, source: 'global', launchMode: 'command' };
        }

        return null;
    }

    listTools(): ToolInfo[] {
        this.detectTools();
        return this.toolDefinitions;
    }

    getToolStatus(toolId: string): ToolInfo | null {
        return this.toolDefinitions.find(t => t.id === toolId) || null;
    }

    getLaunchConfig(toolId: string, resumeId?: string): LaunchConfig | null {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool) return null;

        const result = this.findToolBin(toolId);
        if (!result) return null;

        const apiKey = this.configStore.getApiKey(tool.provider);
        const baseUrl = this.configStore.getBaseUrl(tool.provider);
        const model = this.configStore.getModel(tool.provider);
        const args: string[] = [];
        const env: Record<string, string> = this.buildRuntimeEnv();

        // =============================================
        // Use CLI FLAGS — highest precedence, guaranteed
        // =============================================

        // Shared config root for all embedded tools.
        // Per-platform location:
        //   Windows: %APPDATA%\TokenWave
        //   macOS:   ~/Library/Application Support/TokenWave
        //   Linux:   ~/.config/TokenWave (XDG_CONFIG_HOME if set)
        const appDataDir = path.join(this.getPlatformAppDataDir(), 'TokenWave');

        if (tool.id === 'claude-code') {
            if (os.platform() === 'win32') {
                const gitBashPath = this.resolveClaudeGitBashPath();
                if (!gitBashPath) {
                    throw new Error(
                        'Claude Code 在 Windows 上需要 Git Bash/MinGit。请重新打包内置 MinGit，或设置 CLAUDE_CODE_GIT_BASH_PATH 指向 bash.exe。'
                    );
                }
                env['CLAUDE_CODE_GIT_BASH_PATH'] = gitBashPath;
                console.log(`[ToolManager] Using Git Bash for Claude Code: ${gitBashPath}`);
            }

            // Isolate bundled Claude Code config from any system-installed Claude Code.
            // Source: cc/src/utils/envUtils.ts → CLAUDE_CONFIG_DIR overrides ~/.claude
            // Source: cc/src/utils/env.ts:25  → .claude.json = join(CLAUDE_CONFIG_DIR, filename)
            //
            // When CLAUDE_CONFIG_DIR is set, CC places everything directly inside
            // it (settings.json, sessions/, backups/, etc.) — no nested .claude/.
            const claudeHomeDir = path.join(appDataDir, 'claude-home');
            fs.mkdirSync(claudeHomeDir, { recursive: true });
            env['CLAUDE_CONFIG_DIR'] = claudeHomeDir;
            console.log(`[ToolManager] Isolated CLAUDE_CONFIG_DIR: ${claudeHomeDir}`);

            // Skip Claude Code's built-in onboarding — 4RouterAi's own welcome page replaces it.
            // .claude.json lives at join(CLAUDE_CONFIG_DIR, filename) (see cc/src/utils/env.ts:24-25).
            const claudeJsonPath = path.join(claudeHomeDir, '.claude.json');
            try {
                let claudeJson: any = {};
                if (fs.existsSync(claudeJsonPath)) {
                    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
                }
                if (!claudeJson.hasCompletedOnboarding) {
                    claudeJson.hasCompletedOnboarding = true;
                    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), 'utf-8');
                    console.log(`[ToolManager] Marked onboarding complete: ${claudeJsonPath}`);
                }
            } catch (e) {
                console.warn(`[ToolManager] Failed to update .claude.json:`, e);
            }

            // Write settings JSON to a temp file to avoid shell escaping issues.
            // Passing JSON inline through PowerShell → cmd.exe → node.exe
            // mangles the string. A file path is always safe.
            //
            // Read any existing settings.json first so user-managed sections
            // (hooks, permissions, statusLine, etc.) survive re-launches.
            // ToolManager only owns the host-controlled env vars below.
            const settingsFile = path.join(claudeHomeDir, 'settings.json');
            let settings: any = { env: {} };
            if (fs.existsSync(settingsFile)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
                    settings = existing;
                    if (!settings.env || typeof settings.env !== 'object') settings.env = {};
                } catch (e) {
                    console.warn('[ToolManager] settings.json unreadable, recreating:', e);
                }
            }
            if (apiKey) {
                settings.env['ANTHROPIC_AUTH_TOKEN'] = apiKey;
            }
            if (baseUrl) {
                settings.env['ANTHROPIC_BASE_URL'] = baseUrl;
            }
            if (model) {
                settings['model'] = model;
            }

            // ── 4RouterAi embedded-environment defaults ──
            // Disable attribution header — 3rd-party base_url proxies don't
            // recognise x-anthropic-billing-header and may reject it.
            settings.env['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0';
            // Suppress all nonessential network traffic (telemetry, auto-update
            // checks, release notes, MCP registry, GrowthBook, etc.). The host
            // app handles updates; these requests would just add latency.
            settings.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
            // Prevent cc from writing OSC escape sequences to change the
            // terminal title — inside xterm.js they are either ignored or
            // produce visual artefacts.
            settings.env['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'] = '1';
            // When ANTHROPIC_BASE_URL is a non-Anthropic host, cc auto-disables
            // tool search (defer_loading / tool_reference). Force it on so MCP
            // tools are lazily loaded, saving context window tokens.
            settings.env['ENABLE_TOOL_SEARCH'] = 'true';
            // Set reasoning effort level for Claude Code.
            const ccEffort = this.configStore.get('ccEffortLevel') as string;
            if (ccEffort) {
                settings.env['CLAUDE_CODE_EFFORT_LEVEL'] = ccEffort;
            }
            // Skip the WebFetch domain-blocklist preflight that hits
            // api.anthropic.com — unreachable through a 3rd-party proxy,
            // causing every WebFetch call to fail with DomainCheckFailedError.
            settings['skipWebFetchPreflight'] = true;

            // Bypass all permission prompts when the user has opted in.
            // Only mutate defaultMode — preserve user-defined allow/deny lists
            // imported from ~/.claude/settings.json.
            if (this.configStore.get('ccBypassPermissions')) {
                settings.permissions = settings.permissions || {};
                settings.permissions.defaultMode = 'bypassPermissions';
            }

            // Write the merged settings file — env block carries 4RouterAi
            // defaults plus host-controlled API credentials, while user
            // sections (hooks, permissions, statusLine) are preserved from
            // any existing file.
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
            args.push('--settings', settingsFile);
            console.log(`[ToolManager] Wrote Claude settings to ${settingsFile}`);
        } else if (tool.id === 'codex') {
            // ── Merge host-controlled settings into config.toml ──
            // Codex reads its config from $CODEX_HOME/config.toml
            // (default: ~/.codex/config.toml). Using a 4RouterAi-
            // scoped directory keeps our config isolated.
            //
            // Important: Codex writes user preferences (trust_level,
            // sandbox mode, notice acknowledgements, etc.) back into
            // this same config.toml at runtime. A full overwrite would
            // destroy those preferences, forcing the user to re-confirm
            // settings on every new session. Instead we regenerate only
            // the host-controlled fields and preserve the rest.
            const codexHomeDir = path.join(appDataDir, 'codex-home');
            fs.mkdirSync(codexHomeDir, { recursive: true });

            // Codex hardcodes its image output to $CODEX_HOME/generated_images.
            // We can't change that, so we redirect via a symlink to a folder
            // inside the user's project so they can find their files.
            this.linkGeneratedImagesToProject(codexHomeDir);

            const lines: string[] = [];

            // ── Root-level keys ──
            // All root-level keys MUST appear before any [section] header,
            // because in TOML everything after a section header belongs to
            // that table until the next section header.
            if (baseUrl) {
                const providerName = '4routerai';
                lines.push(`model_provider = "${providerName}"`);
            }
            if (model) {
                lines.push(`model = "${model}"`);
            }
            const reasoningEffort = this.configStore.get('codexReasoningEffort') as string;
            if (reasoningEffort) {
                lines.push(`model_reasoning_effort = "${reasoningEffort}"`);
            }
            const verbosity = this.configStore.get('codexVerbosity') as string;
            if (verbosity) {
                lines.push(`model_verbosity = "${verbosity}"`);
            }
            lines.push('model_context_window = 1000000');
            lines.push('model_auto_compact_token_limit = 9000000');
            lines.push('check_for_update_on_startup = false');

            // Bypass all approval prompts and sandbox when the user has opted in.
            if (this.configStore.get('codexBypassPermissions')) {
                lines.push('approval_policy = "never"');
                lines.push('sandbox_mode = "danger-full-access"');
            }

            // ── Sections ──
            if (baseUrl) {
                const providerName = '4routerai';
                lines.push('');
                lines.push(`[model_providers.${providerName}]`);
                lines.push(`name = "${providerName}"`);
                lines.push(`base_url = "${baseUrl}"`);
                lines.push(`wire_api = "responses"`);
            }

            lines.push('');
            lines.push('[analytics]');
            lines.push('enabled = false');

            // ── Preserve user preferences from existing config ──
            const configFile = path.join(codexHomeDir, 'config.toml');
            let userConfig = '';
            if (fs.existsSync(configFile)) {
                try {
                    userConfig = preserveUserConfig(fs.readFileSync(configFile, 'utf-8'));
                } catch (e) {
                    console.warn(`[ToolManager] Failed to read existing config.toml, starting fresh:`, e);
                }
            }

            const configToml = lines.join('\n') + '\n' + userConfig;
            fs.writeFileSync(configFile, configToml, 'utf-8');
            console.log(`[ToolManager] Wrote Codex config to ${configFile}`);

            // Tell codex to use our isolated config directory.
            env['CODEX_HOME'] = codexHomeDir;

            // Write API key into auth.json — codex's native credential
            // storage format (see codex-rs/login/src/auth/manager.rs).
            // This avoids relying on the OPENAI_API_KEY env var which
            // could leak into child processes.
            if (apiKey) {
                const authJson = {
                    auth_mode: 'apikey',
                    OPENAI_API_KEY: apiKey,
                };
                const authFile = path.join(codexHomeDir, 'auth.json');
                fs.writeFileSync(authFile, JSON.stringify(authJson, null, 2), 'utf-8');
                console.log(`[ToolManager] Wrote Codex auth to ${authFile}`);
            }
        }

        // Proxy
        const proxy = this.configStore.get('proxy') as string | undefined;
        if (proxy) {
            env['HTTP_PROXY'] = proxy;
            env['HTTPS_PROXY'] = proxy;
        }

        // ── Resume an existing session ──
        // Claude: `claude --resume <sessionId>` (flag, appended to args).
        // Codex:  `codex resume <SESSION_ID>` (subcommand — must be the first
        //         positional arg, so unshift before any other flags).
        if (resumeId) {
            if (tool.id === 'claude-code') {
                args.push('--resume', resumeId);
            } else if (tool.id === 'codex') {
                args.unshift('resume', resumeId);
            }
        }

        console.log(`[ToolManager] Launch: ${toolId}`, {
            bin: result.launchMode === 'node-script' ? this.getBundledNodeExecutable() : result.path,
            args,
            hasApiKey: !!apiKey,
            hasBaseUrl: !!baseUrl,
        });

        if (result.launchMode === 'node-script') {
            return { bin: this.getBundledNodeExecutable(), args: [result.path, ...args], env };
        }

        return { bin: result.path, args, env };
    }

    /**
     * Check if a newer version is available by querying npm registry.
     */
    async checkUpdate(toolId: string): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string }> {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool || !tool.version) {
            return { hasUpdate: false, currentVersion: 'unknown', latestVersion: 'unknown' };
        }

        const packageName = toolId === 'claude-code'
            ? '@anthropic-ai/claude-code'
            : '@openai/codex';

        return new Promise((resolve) => {
            const { execFile } = require('child_process') as typeof import('child_process');
            const npmExec = this.getBundledNodeExecutable();
            const npmCli = this.getBundledNpmCli();
            if (!this.hasBundledRuntime()) {
                resolve({ hasUpdate: false, currentVersion: tool.version!, latestVersion: 'unknown' });
                return;
            }

            execFile(npmExec, [npmCli, 'view', packageName, 'version'], {
                timeout: 15000,
                windowsHide: true,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
            }, (error, stdout) => {
                if (error || !stdout.trim()) {
                    resolve({ hasUpdate: false, currentVersion: tool.version!, latestVersion: 'unknown' });
                    return;
                }
                const latest = stdout.trim();
                const hasUpdate = latest !== tool.version;
                console.log(`[ToolManager] ${toolId}: current=${tool.version}, latest=${latest}, hasUpdate=${hasUpdate}`);
                resolve({ hasUpdate, currentVersion: tool.version!, latestVersion: latest });
            });
        });
    }

    /**
     * Update a bundled tool to the latest version by running
     * `npm install <package>@latest` in the tool's bundled directory.
     */
    async updateTool(toolId: string): Promise<{ success: boolean; version?: string; error?: string }> {
        const tool = this.toolDefinitions.find(t => t.id === toolId);
        if (!tool) return { success: false, error: 'Unknown tool' };

        const packageName = toolId === 'claude-code'
            ? '@anthropic-ai/claude-code'
            : '@openai/codex';

        const toolDir = path.join(this.bundledToolsPath,
            toolId === 'claude-code' ? 'claude-code' : 'codex');

        if (!fs.existsSync(toolDir)) {
            fs.mkdirSync(toolDir, { recursive: true });
        }

        // Ensure package.json exists (npm install requires it)
        const pkgJsonPath = path.join(toolDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            fs.writeFileSync(pkgJsonPath, '{"private":true}', 'utf-8');
        }

        console.log(`[ToolManager] Updating ${toolId} in ${toolDir}`);
        console.log(`[ToolManager] Package: ${packageName}@latest`);

        const result = await this.npmInstall(packageName, toolDir);
        if (!result.success) return result;

        // Both Claude Code (≥2.1.113) and Codex distribute platform-specific
        // native binaries via optional dependencies. Chinese mirrors like
        // npmmirror may lag behind on syncing these. If the platform package
        // is missing after install, retry with the official npm registry.
        const hasPlatformPkg = toolId === 'claude-code'
            ? this.hasClaudeCodePlatformPackage(toolDir)
            : toolId === 'codex'
                ? this.hasCodexPlatformPackage(toolDir)
                : true;

        if (!hasPlatformPkg) {
            console.log(`[ToolManager] ${toolId} platform package missing after install, retrying with official registry...`);
            const fallback = await this.npmInstall(packageName, toolDir, 'https://registry.npmjs.org/');
            if (!fallback.success) return fallback;

            const hasPlatformPkgRetry = toolId === 'claude-code'
                ? this.hasClaudeCodePlatformPackage(toolDir)
                : this.hasCodexPlatformPackage(toolDir);
            if (!hasPlatformPkgRetry) {
                return { success: false, error: 'Platform-specific binary still missing after fallback install' };
            }
        }

        this.detectTools();
        const updated = this.toolDefinitions.find(t => t.id === toolId);
        return { success: true, version: updated?.version || 'unknown' };
    }

    private npmInstall(
        packageName: string,
        cwd: string,
        registry?: string,
    ): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            const { execFile } = require('child_process') as typeof import('child_process');
            if (!this.hasBundledRuntime()) {
                resolve({ success: false, error: 'Bundled Node.js runtime is missing' });
                return;
            }

            const npmExec = this.getBundledNodeExecutable();
            const npmCli = this.getBundledNpmCli();
            const commandArgs = [npmCli, 'install', `${packageName}@latest`];
            if (registry) {
                commandArgs.push('--registry', registry);
            }
            console.log(`[ToolManager] Running: ${npmExec} ${commandArgs.join(' ')}`);

            execFile(npmExec, commandArgs, {
                cwd,
                timeout: 120000,
                env: buildSanitizedEnv(this.buildRuntimeEnv()),
                windowsHide: true,
            }, (error: any, stdout: string, stderr: string) => {
                const output = (stdout || '') + (stderr || '');
                console.log(`[ToolManager] Install output:`, output);
                if (error) {
                    const msg = `${error.message}\n${output}`.trim();
                    console.error(`[ToolManager] Install failed:`, msg);
                    resolve({ success: false, error: msg });
                } else {
                    resolve({ success: true });
                }
            });
        });
    }

    private hasClaudeCodePlatformPackage(toolDir: string): boolean {
        const PLATFORM_PKG: Record<string, Record<string, string>> = {
            win32:  { x64: 'claude-code-win32-x64', arm64: 'claude-code-win32-arm64' },
            darwin: { x64: 'claude-code-darwin-x64', arm64: 'claude-code-darwin-arm64' },
            linux:  { x64: 'claude-code-linux-x64',  arm64: 'claude-code-linux-arm64' },
        };
        const pkgName = PLATFORM_PKG[os.platform()]?.[os.arch()];
        if (!pkgName) return true;
        const pkgDir = path.join(toolDir, 'node_modules', '@anthropic-ai', pkgName);
        const exists = fs.existsSync(pkgDir);
        console.log(`[ToolManager] Claude Code platform package check: ${pkgDir} → ${exists}`);
        return exists;
    }

    private hasCodexPlatformPackage(toolDir: string): boolean {
        const PLATFORM_PKG: Record<string, Record<string, string>> = {
            win32:  { x64: 'codex-win32-x64', arm64: 'codex-win32-arm64' },
            darwin: { x64: 'codex-darwin-x64', arm64: 'codex-darwin-arm64' },
            linux:  { x64: 'codex-linux-x64',  arm64: 'codex-linux-arm64' },
        };
        const pkgName = PLATFORM_PKG[os.platform()]?.[os.arch()];
        if (!pkgName) return true; // unknown platform, skip check
        const pkgDir = path.join(toolDir, 'node_modules', '@openai', pkgName);
        const exists = fs.existsSync(pkgDir);
        console.log(`[ToolManager] Platform package check: ${pkgDir} → ${exists}`);
        return exists;
    }
}
