// ============================================================
// TokenWave — Extensions panel (MCP servers + Claude Skills)
// Rendered into #ext-panel-mcp and #ext-panel-skills.
// All host integration (api, dialogs, editor) comes in via `hooks` so this
// module stays decoupled from app.js internals.
// ============================================================

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
}

function mask(v) {
    const s = String(v ?? '');
    if (s.length <= 4) return '••••';
    return s.slice(0, 2) + '••••' + s.slice(-2);
}

/**
 * @param {{ mcp: HTMLElement, skills: HTMLElement }} panels
 * @param {any} api
 * @param {{ toast, promptDialog, confirmDialog, openFileInEditor, closeModal }} hooks
 * @returns {{ refresh: () => void }}
 */
export function createExtensionsPanel(panels, api, hooks) {
    const { toast, promptDialog, confirmDialog, openFileInEditor, closeModal } = hooks;

    // ───────────────────────── MCP ─────────────────────────
    async function renderMcp() {
        panels.mcp.innerHTML = '';

        const hint = el('p', 'ext-hint',
            '配置的 MCP 服务器会写入对应 CLI 的配置目录，<b>下次启动该工具时生效</b>。' +
            '若 Claude Code 未加载，请反馈，我们会调整写入位置。');
        panels.mcp.append(hint);

        const toolbar = el('div', 'ext-toolbar');
        const btnSearch = el('button', 'btn-secondary btn-small', '🔍 搜索市场');
        btnSearch.addEventListener('click', openMcpMarket);
        const btnAdd = el('button', 'btn-primary btn-small', '+ 新增 MCP');
        btnAdd.addEventListener('click', () => openMcpForm(null));
        toolbar.append(btnSearch, btnAdd);
        panels.mcp.append(toolbar);

        let servers = [];
        try { servers = await api.mcp.list(); } catch (err) { toast(String(err?.message || err), 'error'); }

        if (!servers.length) {
            panels.mcp.append(el('div', 'ext-empty', '还没有配置 MCP 服务器'));
            return;
        }

        const list = el('div', 'ext-list');
        for (const s of servers) list.append(mcpRow(s));
        panels.mcp.append(list);
    }

    function mcpRow(s) {
        const row = el('div', 'ext-row' + (s.enabled ? '' : ' ext-row-disabled'));

        const main = el('div', 'ext-row-main');
        const title = el('div', 'ext-row-title');
        title.append(el('span', 'ext-name', s.name));
        title.append(el('span', 'ext-badge', s.transport));
        for (const t of s.targets || []) {
            title.append(el('span', 'ext-badge ' + (t === 'codex' ? 'ext-badge-codex' : 'ext-badge-claude'),
                t === 'codex' ? '🟢 Codex' : '🟣 Claude'));
        }
        if (s.raw) title.append(el('span', 'ext-badge ext-badge-raw', '只读·导入'));
        main.append(title);

        const sub = s.transport === 'http'
            ? (s.url || '')
            : [s.command, ...(s.args || [])].filter(Boolean).join(' ');
        const subEl = el('div', 'ext-row-sub');
        subEl.textContent = sub;
        main.append(subEl);

        if (s.env && Object.keys(s.env).length) {
            const envEl = el('div', 'ext-row-env');
            envEl.textContent = Object.entries(s.env).map(([k, v]) => `${k}=${mask(v)}`).join('  ');
            main.append(envEl);
        }
        row.append(main);

        const actions = el('div', 'ext-row-actions');
        const toggle = makeToggle(s.enabled, async (next) => {
            const r = await api.mcp.toggle(s.name, next);
            if (!r?.success) { toast(r?.error || '切换失败', 'error'); renderMcp(); }
            else { toast(next ? '已启用' : '已禁用'); renderMcp(); }
        });
        actions.append(toggle);

        if (!s.raw) {
            const edit = el('button', 'btn-icon', '✏️');
            edit.title = '编辑';
            edit.addEventListener('click', () => openMcpForm(s));
            actions.append(edit);
        }
        const del = el('button', 'btn-icon', '🗑');
        del.title = '删除';
        del.addEventListener('click', async () => {
            if (!(await confirmDialog(`删除 MCP 服务器「${s.name}」？`, true))) return;
            const r = await api.mcp.remove(s.name);
            if (!r?.success) toast(r?.error || '删除失败', 'error');
            else { toast('已删除'); renderMcp(); }
        });
        actions.append(del);
        row.append(actions);

        return row;
    }

    // MCP add/edit form, rendered as an overlay inside the modal body.
    function openMcpForm(existing) {
        const isEdit = !!existing;
        const overlay = el('div', 'ext-form-overlay');
        const form = el('div', 'ext-form');
        form.append(el('h3', null, isEdit ? '编辑 MCP 服务器' : '新增 MCP 服务器'));

        // name
        const nameInput = el('input', 'text-input');
        nameInput.placeholder = '名称（字母/数字/._-）';
        nameInput.value = existing?.name || '';
        form.append(field('名称', nameInput));

        // transport
        const transportSel = el('select', 'text-input');
        for (const [v, label] of [['stdio', 'stdio（本地命令）'], ['http', 'http（远程，仅 Claude）']]) {
            const o = el('option', null, label); o.value = v; transportSel.append(o);
        }
        transportSel.value = existing?.transport || 'stdio';
        form.append(field('类型', transportSel));

        // stdio fields
        const cmdInput = el('input', 'text-input');
        cmdInput.placeholder = '可执行命令，如 npx';
        cmdInput.value = existing?.command || '';
        const cmdField = field('命令', cmdInput);

        const argsInput = el('textarea', 'text-input');
        argsInput.rows = 2;
        argsInput.placeholder = '参数，每行一个，如\n-y\n@modelcontextprotocol/server-filesystem';
        argsInput.value = (existing?.args || []).join('\n');
        const argsField = field('参数', argsInput);

        // http fields
        const urlInput = el('input', 'text-input');
        urlInput.placeholder = 'https://example.com/mcp';
        urlInput.value = existing?.url || '';
        const urlField = field('URL', urlInput);

        // env / headers (key=value per line; values stored as-is)
        const envInput = el('textarea', 'text-input');
        envInput.rows = 2;
        envInput.placeholder = 'KEY=VALUE，每行一个（敏感值将打码显示）';
        envInput.value = kvToText(existing?.transport === 'http' ? existing?.headers : existing?.env);
        const envField = field(existing?.transport === 'http' ? 'Headers' : 'Env / Headers', envInput);

        // startup timeout
        const timeoutInput = el('input', 'text-input');
        timeoutInput.type = 'number';
        timeoutInput.placeholder = 'Codex 启动超时（毫秒，可空）';
        if (existing?.startupTimeoutMs) timeoutInput.value = String(existing.startupTimeoutMs);
        const timeoutField = field('启动超时(ms)', timeoutInput);

        form.append(cmdField, argsField, urlField, envField, timeoutField);

        // targets
        const claudeCb = checkbox('🟣 Claude Code', (existing?.targets || ['claude-code']).includes('claude-code'));
        const codexCb = checkbox('🟢 Codex', (existing?.targets || []).includes('codex'));
        const targetsRow = el('div', 'ext-targets');
        targetsRow.append(el('label', 'ext-field-label', '配置到'));
        targetsRow.append(claudeCb.wrap, codexCb.wrap);
        form.append(targetsRow);

        const errBox = el('div', 'ext-form-error');
        form.append(errBox);

        // toggle field visibility by transport; http disables Codex
        function syncFields() {
            const http = transportSel.value === 'http';
            cmdField.classList.toggle('hidden', http);
            argsField.classList.toggle('hidden', http);
            timeoutField.classList.toggle('hidden', http);
            urlField.classList.toggle('hidden', !http);
            envField.querySelector('label').textContent = http ? 'Headers' : 'Env';
            codexCb.input.disabled = http;
            if (http && codexCb.input.checked) codexCb.input.checked = false;
            codexCb.wrap.classList.toggle('ext-disabled', http);
        }
        transportSel.addEventListener('change', syncFields);
        syncFields();

        const buttons = el('div', 'ext-form-buttons');
        const cancel = el('button', 'btn-secondary', '取消');
        cancel.addEventListener('click', () => overlay.remove());
        const save = el('button', 'btn-primary', '保存');
        save.addEventListener('click', async () => {
            errBox.textContent = '';
            const transport = transportSel.value;
            const targets = [];
            if (claudeCb.input.checked) targets.push('claude-code');
            if (codexCb.input.checked) targets.push('codex');
            if (!targets.length) { errBox.textContent = '请至少选择一个目标 CLI'; return; }

            const server = {
                name: nameInput.value.trim(),
                transport,
                targets,
                enabled: true,
            };
            if (transport === 'http') {
                if (!urlInput.value.trim()) { errBox.textContent = '请填写 URL'; return; }
                server.url = urlInput.value.trim();
                const h = textToKv(envInput.value);
                if (Object.keys(h).length) server.headers = h;
            } else {
                if (!cmdInput.value.trim()) { errBox.textContent = '请填写命令'; return; }
                server.command = cmdInput.value.trim();
                server.args = argsInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
                const e = textToKv(envInput.value);
                if (Object.keys(e).length) server.env = e;
                const t = parseInt(timeoutInput.value, 10);
                if (!Number.isNaN(t)) server.startupTimeoutMs = t;
            }

            const r = isEdit
                ? await api.mcp.update(existing.name, server)
                : await api.mcp.add(server);
            if (!r?.success) { errBox.textContent = r?.error || '保存失败'; return; }
            if (r.partial?.length) toast('部分目标写入失败：' + r.partial.join(', '), 'error');
            else toast('已保存，下次启动该工具生效');
            overlay.remove();
            renderMcp();
        });
        buttons.append(cancel, save);
        form.append(buttons);

        overlay.append(form);
        panels.mcp.closest('.modal-body').append(overlay);
    }

    function makeToggle(on, onChange) {
        const label = el('label', 'ext-switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = on;
        input.addEventListener('change', () => onChange(input.checked));
        const slider = el('span', 'ext-switch-slider');
        label.append(input, slider);
        return label;
    }

    function field(labelText, control) {
        const f = el('div', 'ext-field');
        f.append(el('label', 'ext-field-label', labelText), control);
        return f;
    }
    function checkbox(labelText, checked) {
        const wrap = el('label', 'ext-checkbox');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = checked;
        wrap.append(input, document.createTextNode(' ' + labelText));
        return { wrap, input };
    }
    function kvToText(obj) {
        if (!obj) return '';
        return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
    }
    function textToKv(text) {
        const out = {};
        for (const line of (text || '').split('\n')) {
            const t = line.trim();
            if (!t) continue;
            const i = t.indexOf('=');
            if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        }
        return out;
    }

    // ──────────────────────── Skills ────────────────────────
    async function renderSkills() {
        panels.skills.innerHTML = '';
        panels.skills.append(el('p', 'ext-hint',
            'Skills 是 Claude Code 的能力扩展（文件夹 + SKILL.md），仅对 Claude Code 生效。'));

        const toolbar = el('div', 'ext-toolbar');
        const btnMarket = el('button', 'btn-secondary btn-small', '🔍 浏览市场');
        btnMarket.addEventListener('click', openSkillsMarket);
        const btnAdd = el('button', 'btn-primary btn-small', '+ 新增 Skill');
        btnAdd.addEventListener('click', addSkill);
        toolbar.append(btnMarket, btnAdd);
        panels.skills.append(toolbar);

        let skills = [];
        try { skills = await api.skills.list(); } catch (err) { toast(String(err?.message || err), 'error'); }

        if (!skills.length) {
            panels.skills.append(el('div', 'ext-empty', '还没有创建 Skill'));
            return;
        }
        const list = el('div', 'ext-list');
        for (const s of skills) list.append(skillRow(s));
        panels.skills.append(list);
    }

    function skillRow(s) {
        const row = el('div', 'ext-row' + (s.enabled ? '' : ' ext-row-disabled'));
        const main = el('div', 'ext-row-main');
        const title = el('div', 'ext-row-title');
        title.append(el('span', 'ext-name', s.name));
        main.append(title);
        const sub = el('div', 'ext-row-sub');
        sub.textContent = s.description || '（无描述）';
        main.append(sub);
        row.append(main);

        const actions = el('div', 'ext-row-actions');
        actions.append(makeToggle(s.enabled, async (next) => {
            const r = await api.skills.toggle(s.name, next);
            if (!r?.success) toast(r?.error || '切换失败', 'error');
            else toast(next ? '已启用' : '已禁用');
            renderSkills();
        }));

        const edit = el('button', 'btn-icon', '✏️');
        edit.title = '编辑 SKILL.md';
        edit.addEventListener('click', async () => {
            await openFileInEditor(s.path, `${s.name}/SKILL.md`);
            closeModal();
        });
        actions.append(edit);

        const del = el('button', 'btn-icon', '🗑');
        del.title = '删除';
        del.addEventListener('click', async () => {
            if (!(await confirmDialog(`删除 Skill「${s.name}」？此操作会删除整个文件夹。`, true))) return;
            const r = await api.skills.remove(s.name);
            if (!r?.success) toast(r?.error || '删除失败', 'error');
            else { toast('已删除'); renderSkills(); }
        });
        actions.append(del);
        row.append(actions);
        return row;
    }

    async function addSkill() {
        const name = await promptDialog('新建 Skill 名称（字母/数字/._-）', '', '下一步');
        if (!name) return;
        const description = await promptDialog('一句话描述这个 Skill 的用途', '', '创建');
        if (description === null) return;
        const r = await api.skills.create(name.trim(), description.trim());
        if (!r?.success) { toast(r?.error || '创建失败', 'error'); return; }
        toast('已创建，正在打开编辑器');
        await openFileInEditor(r.path, `${name.trim()}/SKILL.md`);
        closeModal();
    }

    // ──────────────────────── Marketplace ────────────────────────

    /** Build a market overlay shell with a title, close button, body. */
    function marketOverlay(hostPanel, title) {
        const overlay = el('div', 'ext-market-overlay');
        const head = el('div', 'ext-market-head');
        head.append(el('h3', null, title));
        const close = el('button', 'btn-icon', '✕');
        close.addEventListener('click', () => overlay.remove());
        head.append(close);
        const body = el('div', 'ext-market-body');
        overlay.append(head, body);
        hostPanel.closest('.modal-body').append(overlay);
        return { overlay, body };
    }

    function resultCard(name, desc, badge, onInstall) {
        const card = el('div', 'ext-market-card');
        const info = el('div', 'ext-market-card-info');
        const title = el('div', 'ext-row-title');
        title.append(el('span', 'ext-name', name));
        if (badge) title.append(el('span', 'ext-badge', badge));
        info.append(title);
        if (desc) {
            const d = el('div', 'ext-row-sub');
            d.textContent = desc;
            info.append(d);
        }
        card.append(info);
        const btn = el('button', 'btn-primary btn-small', '安装');
        btn.addEventListener('click', () => onInstall(btn));
        card.append(btn);
        return card;
    }

    function openMcpMarket() {
        const { body } = marketOverlay(panels.mcp, '🔍 MCP 市场');

        // manual install row
        const manual = el('div', 'ext-market-manual');
        const manualInput = el('input', 'text-input');
        manualInput.placeholder = '粘贴 npm 包名（如 @scope/server-foo）后点安装';
        const manualBtn = el('button', 'btn-secondary btn-small', '安装');
        manualBtn.addEventListener('click', () => installMcp({ pkgOrUrl: manualInput.value.trim() }, manualBtn));
        manual.append(manualInput, manualBtn);
        body.append(manual);

        // search row
        const searchRow = el('div', 'ext-market-search');
        const input = el('input', 'text-input');
        input.placeholder = '搜索官方 MCP Registry…';
        const go = el('button', 'btn-primary btn-small', '搜索');
        searchRow.append(input, go);
        body.append(searchRow);

        const results = el('div', 'ext-market-results');
        body.append(results);

        const doSearch = async () => {
            results.innerHTML = '';
            results.append(el('div', 'ext-market-loading', '搜索中…'));
            const r = await api.mcp.search(input.value.trim());
            results.innerHTML = '';
            if (!r?.success) { results.append(el('div', 'ext-empty', r?.error || '搜索失败')); return; }
            if (!r.items.length) { results.append(el('div', 'ext-empty', '没有结果')); return; }
            for (const item of r.items) {
                results.append(resultCard(item.name, item.description,
                    item.kind === 'http' ? 'http' : 'stdio',
                    (btn) => chooseTargetsAndInstall(item, btn)));
            }
        };
        go.addEventListener('click', doSearch);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
        input.focus();
    }

    // Ask which CLIs to install to (http disables Codex), then install.
    async function chooseTargetsAndInstall(item, btn) {
        const targets = ['claude-code'];
        if (item.kind !== 'http') {
            const both = await confirmDialog('同时安装到 Codex？（取消 = 仅 Claude Code）', false);
            if (both) targets.push('codex');
        }
        installMcp({ item, targets }, btn);
    }

    async function installMcp(payload, btn) {
        if (payload.pkgOrUrl === '') { toast('请输入 npm 包名', 'error'); return; }
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '安装中…';
        let r = await api.mcp.install({ ...payload, targets: payload.targets || ['claude-code'] });
        if (!r?.success && r?.code === 'EEXIST') {
            if (await confirmDialog(`已存在同名 MCP「${r.name}」，覆盖？`, true)) {
                r = await api.mcp.install({ ...payload, targets: payload.targets || ['claude-code'], overwrite: true });
            } else { btn.disabled = false; btn.textContent = orig; return; }
        }
        btn.disabled = false; btn.textContent = orig;
        if (!r?.success) { toast(r?.error || '安装失败', 'error'); return; }
        if (r.partial?.length) toast('部分目标写入失败：' + r.partial.join(', '), 'error');
        else toast('已安装，下次启动该工具生效');
        renderMcp();
    }

    function openSkillsMarket() {
        const { body } = marketOverlay(panels.skills, '🔍 Skills 市场');

        // repo override + URL install
        const repoRow = el('div', 'ext-market-search');
        const repoInput = el('input', 'text-input');
        repoInput.placeholder = '市场仓库 owner/repo（留空用默认）';
        const loadBtn = el('button', 'btn-primary btn-small', '加载');
        repoRow.append(repoInput, loadBtn);
        body.append(repoRow);

        const urlRow = el('div', 'ext-market-manual');
        const urlInput = el('input', 'text-input');
        urlInput.placeholder = '或粘贴 GitHub skill 目录地址 → 安装';
        const urlBtn = el('button', 'btn-secondary btn-small', '安装');
        urlBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) { toast('请输入地址', 'error'); return; }
            await installSkill({ url, fromUrl: true }, urlBtn);
        });
        urlRow.append(urlInput, urlBtn);
        body.append(urlRow);

        const results = el('div', 'ext-market-results');
        body.append(results);

        const load = async () => {
            results.innerHTML = '';
            results.append(el('div', 'ext-market-loading', '加载中…'));
            const r = await api.skills.search(repoInput.value.trim() || undefined);
            results.innerHTML = '';
            if (!r?.success) { results.append(el('div', 'ext-empty', r?.error || '加载失败')); return; }
            if (!r.items.length) { results.append(el('div', 'ext-empty', '该仓库没有可用 skill')); return; }
            for (const item of r.items) {
                results.append(resultCard(item.name, item.description, null,
                    (btn) => installSkill({ repo: item.repo, dirPath: item.dirPath, name: item.name }, btn)));
            }
        };
        loadBtn.addEventListener('click', load);
        load();
    }

    async function installSkill(payload, btn) {
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = '安装中…';
        const call = (overwrite) => payload.fromUrl
            ? api.skills.installUrl({ url: payload.url, overwrite })
            : api.skills.install({ repo: payload.repo, dirPath: payload.dirPath, name: payload.name, overwrite });
        let r = await call(false);
        if (!r?.success && r?.code === 'EEXIST') {
            if (await confirmDialog('已存在同名 Skill，覆盖？', true)) r = await call(true);
            else { btn.disabled = false; btn.textContent = orig; return; }
        }
        btn.disabled = false; btn.textContent = orig;
        if (!r?.success) { toast(r?.error || '安装失败', 'error'); return; }
        toast('已安装，下次启动 Claude Code 生效');
        renderSkills();
    }

    return {
        refresh() { renderMcp(); renderSkills(); },
    };
}
