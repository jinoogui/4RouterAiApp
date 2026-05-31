import * as fs from 'fs';
import * as path from 'path';
import { ToolManager } from './tool-manager';

const DISABLED_PREFIX = '.disabled-';

export interface SkillMeta {
    dirName: string;        // actual directory name (prefixed when disabled)
    name: string;           // frontmatter name (falls back to dirName)
    description: string;
    enabled: boolean;
    path: string;           // absolute path to SKILL.md (for openFileInEditor)
    allowedTools?: string;
    userInvocable?: boolean;
}

export interface SkillResult {
    success: boolean;
    path?: string;
    content?: string;
    error?: string;
    code?: string;
}

/**
 * SkillsManager — manages Claude Code skills living under
 * <claude-home>/skills/<name>/SKILL.md. A skill is "enabled" simply by
 * existing; to disable one we rename its folder with a "." prefix so Claude
 * Code (which skips dot-directories) ignores it. Codex has no skill concept.
 */
export class SkillsManager {
    constructor(private readonly toolManager: ToolManager) {}

    private skillsDir(): string {
        return path.join(this.toolManager.getAppDataDir(), 'claude-home', 'skills');
    }

    /** A skill name is also a folder name, so keep it filesystem-safe. */
    private sanitize(name: string): string | null {
        const trimmed = (name || '').trim();
        if (!trimmed || trimmed.length > 64) return null;
        if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
        if (trimmed.startsWith('.')) return null; // dot-dirs are treated as disabled
        return trimmed;
    }

    /** Resolve a logical skill name to its on-disk folder (enabled or disabled). */
    private resolveDir(name: string): string | null {
        const dir = this.skillsDir();
        const enabled = path.join(dir, name);
        const disabled = path.join(dir, DISABLED_PREFIX + name);
        if (fs.existsSync(enabled)) return enabled;
        if (fs.existsSync(disabled)) return disabled;
        return null;
    }

    /** Guard against any path escaping the skills directory. */
    private within(target: string): boolean {
        const root = path.resolve(this.skillsDir());
        return path.resolve(target).startsWith(root + path.sep);
    }

    list(): SkillMeta[] {
        const dir = this.skillsDir();
        if (!fs.existsSync(dir)) return [];
        const out: SkillMeta[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const disabled = entry.name.startsWith(DISABLED_PREFIX);
            const logical = disabled ? entry.name.slice(DISABLED_PREFIX.length) : entry.name;
            const skillMd = path.join(dir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillMd)) continue;
            let fm: any = {};
            try { fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf-8')); } catch { /* keep defaults */ }
            out.push({
                dirName: entry.name,
                name: fm.name || logical,
                description: fm.description || '',
                enabled: !disabled,
                path: skillMd,
                allowedTools: fm['allowed-tools'],
                userInvocable: fm['user-invocable'] === 'true' || fm['user-invocable'] === true,
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    create(name: string, description: string): SkillResult {
        const safe = this.sanitize(name);
        if (!safe) return { success: false, error: '名称非法（仅允许字母/数字/._-，不能以点开头）' };
        if (this.resolveDir(safe)) return { success: false, error: `已存在同名技能：${safe}` };

        const skillDir = path.join(this.skillsDir(), safe);
        try {
            fs.mkdirSync(skillDir, { recursive: true });
            const file = path.join(skillDir, 'SKILL.md');
            fs.writeFileSync(file, skeleton(safe, description || ''), { encoding: 'utf-8', flag: 'wx' });
            return { success: true, path: file };
        } catch (err: any) {
            return { success: false, error: err?.message || '创建技能失败' };
        }
    }

    /**
     * Install a downloaded skill (a set of relative-path files) into its own
     * folder. Refuses to overwrite unless `overwrite` is set; every file path
     * is validated to stay within the skill directory (no `..` traversal).
     */
    installFromFiles(name: string, files: { rel: string; content: string }[], overwrite: boolean): SkillResult {
        const safe = this.sanitize(name);
        if (!safe) return { success: false, error: '名称非法（仅允许字母/数字/._-，不能以点开头）' };

        const existing = this.resolveDir(safe);
        if (existing && !overwrite) {
            return { success: false, error: 'exists', code: 'EEXIST' };
        }
        if (!files.some((f) => /^SKILL\.md$/i.test(f.rel))) {
            return { success: false, error: '缺少 SKILL.md，不是有效的 Skill' };
        }

        const skillDir = path.join(this.skillsDir(), safe);
        const skillRoot = path.resolve(skillDir);
        try {
            if (existing) fs.rmSync(existing, { recursive: true, force: true });
            fs.mkdirSync(skillDir, { recursive: true });
            for (const f of files) {
                const dest = path.resolve(skillDir, f.rel);
                // reject anything resolving outside the skill folder
                if (dest !== skillRoot && !dest.startsWith(skillRoot + path.sep)) {
                    throw new Error(`非法文件路径：${f.rel}`);
                }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, f.content, 'utf-8');
            }
            return { success: true, path: path.join(skillDir, 'SKILL.md') };
        } catch (err: any) {
            return { success: false, error: err?.message || '安装技能失败' };
        }
    }

    read(name: string): SkillResult {
        const dir = this.resolveDir(name);
        if (!dir) return { success: false, error: '未找到该技能' };
        try {
            return { success: true, content: fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8') };
        } catch (err: any) {
            return { success: false, error: err?.message || '读取失败' };
        }
    }

    update(name: string, content: string): SkillResult {
        const dir = this.resolveDir(name);
        if (!dir || !this.within(dir)) return { success: false, error: '未找到该技能' };
        try {
            fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '保存失败' };
        }
    }

    remove(name: string): SkillResult {
        const dir = this.resolveDir(name);
        if (!dir) return { success: true }; // already gone
        if (!this.within(dir)) return { success: false, error: '路径越界' };
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || '删除失败' };
        }
    }

    /** Enable/disable by renaming the folder to add/remove the dot prefix. */
    toggle(name: string, enabled: boolean): SkillResult {
        const dir = this.resolveDir(name);
        if (!dir || !this.within(dir)) return { success: false, error: '未找到该技能' };
        const base = path.basename(dir);
        const isDisabled = base.startsWith(DISABLED_PREFIX);
        if (enabled === !isDisabled) return { success: true }; // already in target state

        const logical = isDisabled ? base.slice(DISABLED_PREFIX.length) : base;
        const nextName = enabled ? logical : DISABLED_PREFIX + logical;
        const nextPath = path.join(this.skillsDir(), nextName);
        if (!this.within(nextPath)) return { success: false, error: '路径越界' };
        try {
            fs.renameSync(dir, nextPath);
            return { success: true, path: path.join(nextPath, 'SKILL.md') };
        } catch (err: any) {
            return { success: false, error: err?.message || '切换失败' };
        }
    }
}

// ── Helpers ──

/** Extract simple `key: value` pairs from a leading YAML frontmatter block. */
function parseFrontmatter(md: string): Record<string, string> {
    const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    const result: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) result[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return result;
}

/** Starter SKILL.md so a freshly created skill is immediately editable. */
function skeleton(name: string, description: string): string {
    return `---
name: ${name}
description: ${description}
---

# ${name}

在此填写技能指令，描述这个 skill 应该做什么、何时触发、以及具体步骤。
`;
}
