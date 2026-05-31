// ============================================================
// TokenWave — Image Generation Panel
// Mounted into an `image` tab wrapper (see app.js openImageTab).
// Text-to-image + image-to-image via the OpenAI-compatible gateway.
// ============================================================

const DEFAULT_MODEL = 'gpt-image-2';
// Preset models. `engine` decides which extra controls apply: the OpenAI
// images endpoint honours size/quality/count; Gemini's generateContent does not.
const MODEL_PRESETS = [
    { value: 'gpt-image-2', label: 'gpt-image-2', engine: 'openai' },
    { value: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image', engine: 'gemini' },
    { value: '__custom__', label: '自定义…', engine: 'openai' },
];
const isGeminiModel = (m) => /^gemini/i.test((m || '').trim());
// gpt-image supports 1024², 1536×1024, 1024×1536; dall-e-3 adds 1792 variants.
// Offer the union — the model ignores/clamps what it doesn't support.
const SIZES = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', 'auto'];
// quality tiers for gpt-image-* (auto lets the model decide).
const QUALITIES = ['auto', 'low', 'medium', 'high'];
// More gpt-image-* controls.
const BACKGROUNDS = [
    { value: 'auto', label: '自动' },
    { value: 'transparent', label: '透明' },
    { value: 'opaque', label: '不透明' },
];
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];
const MODERATIONS = [
    { value: 'auto', label: '标准' },
    { value: 'low', label: '宽松' },
];
// Gemini-only controls (generationConfig.imageConfig).
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
}

/**
 * Render the image-generation panel into `wrapper`.
 * @param {HTMLElement} wrapper
 * @param {any} api  the routerAi bridge
 * @param {{ onToast?: (msg: string, kind?: string) => void }} [hooks]
 * @returns {{ destroy: () => void }}
 */
export function createImagePanel(wrapper, api, hooks = {}) {
    const toast = hooks.onToast || (() => {});

    /** @type {'generate'|'edit'} */
    let mode = 'generate';
    /** @type {string|null} */
    let sourcePath = null;
    let busy = false;

    // ---- Layout ----
    const panel = el('div', 'image-panel');
    wrapper.appendChild(panel);

    // Mode switch
    const modeRow = el('div', 'image-mode-row');
    const btnT2I = el('button', 'image-mode-btn active', '文生图');
    const btnI2I = el('button', 'image-mode-btn', '图生图');
    modeRow.append(btnT2I, btnI2I);

    // Form
    const form = el('div', 'image-form');

    const promptField = el('div', 'image-field');
    promptField.append(el('label', null, '图片描述'));
    const promptInput = el('textarea', 'image-textarea');
    promptInput.placeholder = '描述你想要的画面，越具体越好…';
    promptInput.rows = 4;
    promptField.append(promptInput);

    // Source image picker (image-to-image only)
    const sourceField = el('div', 'image-field image-source-field hidden');
    sourceField.append(el('label', null, '源图片'));
    const sourceRow = el('div', 'image-source-row');
    const btnPick = el('button', 'btn-secondary btn-small', '选择源图片');
    const sourceThumb = el('img', 'image-source-thumb hidden');
    const sourceName = el('span', 'image-source-name', '未选择');
    sourceRow.append(btnPick, sourceThumb, sourceName);
    sourceField.append(sourceRow);

    // Model + size + count, inline
    const optsRow = el('div', 'image-opts-row');

    const modelField = el('div', 'image-field image-field-grow');
    modelField.append(el('label', null, '模型'));
    const modelSelect = el('select', 'text-input');
    for (const m of MODEL_PRESETS) {
        const opt = el('option', null, m.label);
        opt.value = m.value;
        modelSelect.append(opt);
    }
    // Custom model name input, shown only when "自定义" is selected.
    const modelCustom = el('input', 'text-input image-model-custom hidden');
    modelCustom.type = 'text';
    modelCustom.placeholder = '输入模型名，如 dall-e-3';
    modelField.append(modelSelect, modelCustom);

    // Resolve the model name the user actually wants.
    const currentModel = () =>
        modelSelect.value === '__custom__'
            ? (modelCustom.value.trim() || DEFAULT_MODEL)
            : modelSelect.value;

    const sizeField = el('div', 'image-field');
    sizeField.append(el('label', null, '尺寸'));
    const sizeSelect = el('select', 'text-input small');
    for (const s of SIZES) {
        const opt = el('option', null, s === 'auto' ? '自动' : s);
        opt.value = s;
        sizeSelect.append(opt);
    }
    sizeField.append(sizeSelect);

    const qualityField = el('div', 'image-field');
    qualityField.append(el('label', null, '清晰度'));
    const qualitySelect = el('select', 'text-input small');
    const QUALITY_LABELS = { auto: '自动', low: '低', medium: '中', high: '高' };
    for (const q of QUALITIES) {
        const opt = el('option', null, QUALITY_LABELS[q] || q);
        opt.value = q;
        qualitySelect.append(opt);
    }
    qualityField.append(qualitySelect);

    const countField = el('div', 'image-field');
    countField.append(el('label', null, '数量'));
    const countSelect = el('select', 'text-input small');
    for (const n of [1, 2, 3, 4]) {
        const opt = el('option', null, String(n));
        opt.value = String(n);
        countSelect.append(opt);
    }
    countField.append(countSelect);

    // gpt-image extras: background, output format, compression, moderation.
    const bgField = el('div', 'image-field');
    bgField.append(el('label', null, '背景'));
    const bgSelect = el('select', 'text-input small');
    for (const b of BACKGROUNDS) {
        const opt = el('option', null, b.label);
        opt.value = b.value;
        bgSelect.append(opt);
    }
    bgField.append(bgSelect);

    const fmtField = el('div', 'image-field');
    fmtField.append(el('label', null, '格式'));
    const fmtSelect = el('select', 'text-input small');
    /** @type {Record<string, HTMLOptionElement>} */
    const fmtOptions = {};
    for (const f of OUTPUT_FORMATS) {
        const opt = el('option', null, f);
        opt.value = f;
        fmtOptions[f] = opt;
        fmtSelect.append(opt);
    }
    fmtField.append(fmtSelect);

    // Compression only applies to jpeg/webp; shown only for those formats.
    const compField = el('div', 'image-field hidden');
    compField.append(el('label', null, '压缩率'));
    const compInput = el('input', 'text-input small');
    compInput.type = 'number';
    compInput.min = '0';
    compInput.max = '100';
    compInput.value = '100';
    compField.append(compInput);

    const modField = el('div', 'image-field');
    modField.append(el('label', null, '审核'));
    const modSelect = el('select', 'text-input small');
    for (const m of MODERATIONS) {
        const opt = el('option', null, m.label);
        opt.value = m.value;
        modSelect.append(opt);
    }
    modField.append(modSelect);

    // Gemini-only: aspect ratio + image resolution (generationConfig.imageConfig).
    const aspectField = el('div', 'image-field');
    aspectField.append(el('label', null, '宽高比'));
    const aspectSelect = el('select', 'text-input small');
    for (const r of ASPECT_RATIOS) {
        const opt = el('option', null, r);
        opt.value = r;
        aspectSelect.append(opt);
    }
    aspectField.append(aspectSelect);

    const gSizeField = el('div', 'image-field');
    gSizeField.append(el('label', null, '分辨率'));
    const gSizeSelect = el('select', 'text-input small');
    for (const s of IMAGE_SIZES) {
        const opt = el('option', null, s);
        opt.value = s;
        gSizeSelect.append(opt);
    }
    gSizeField.append(gSizeSelect);

    optsRow.append(modelField, sizeField, qualityField, countField, bgField, fmtField, compField, modField, aspectField, gSizeField);

    // Submit + inline error
    const btnSubmit = el('button', 'btn-primary image-submit', '生成');
    const errorBox = el('div', 'image-error');

    form.append(promptField, sourceField, optsRow, btnSubmit, errorBox);

    // Each engine exposes a different control set: OpenAI gets size/quality/
    // count + the gpt-image extras, Gemini gets aspect-ratio/resolution.
    function syncModelControls() {
        const isCustom = modelSelect.value === '__custom__';
        modelCustom.classList.toggle('hidden', !isCustom);
        const gemini = isGeminiModel(currentModel());
        // OpenAI-only controls.
        for (const f of [sizeField, qualityField, countField, bgField, fmtField, modField]) {
            f.classList.toggle('hidden', gemini);
        }
        // Compression is OpenAI-only AND jpeg/webp-only.
        const compApplies = !gemini && (fmtSelect.value === 'jpeg' || fmtSelect.value === 'webp');
        compField.classList.toggle('hidden', !compApplies);
        // Gemini-only controls.
        aspectField.classList.toggle('hidden', !gemini);
        gSizeField.classList.toggle('hidden', !gemini);
    }
    // Transparent backgrounds need an alpha-capable format. When "透明" is
    // chosen, disable jpeg and snap the format to png if jpeg was selected.
    function syncBackgroundConstraint() {
        const transparent = bgSelect.value === 'transparent';
        fmtOptions.jpeg.disabled = transparent;
        if (transparent && fmtSelect.value === 'jpeg') {
            fmtSelect.value = 'png';
        }
    }

    modelSelect.addEventListener('change', syncModelControls);
    modelCustom.addEventListener('input', syncModelControls);
    fmtSelect.addEventListener('change', syncModelControls);
    bgSelect.addEventListener('change', () => { syncBackgroundConstraint(); syncModelControls(); });
    syncBackgroundConstraint();
    syncModelControls();

    // Results
    const results = el('div', 'image-results');
    const resultsEmpty = el('div', 'image-results-empty', '生成的图片会显示在这里');
    results.append(resultsEmpty);

    panel.append(modeRow, form, results);

    // ---- Behavior ----
    function setError(msg) {
        errorBox.textContent = msg || '';
        errorBox.classList.toggle('visible', !!msg);
    }

    function setMode(next) {
        mode = next;
        btnT2I.classList.toggle('active', mode === 'generate');
        btnI2I.classList.toggle('active', mode === 'edit');
        sourceField.classList.toggle('hidden', mode !== 'edit');
        setError('');
    }

    function setBusy(on) {
        busy = on;
        btnSubmit.disabled = on;
        btnSubmit.textContent = on ? '生成中…' : '生成';
    }

    btnT2I.addEventListener('click', () => setMode('generate'));
    btnI2I.addEventListener('click', () => setMode('edit'));

    btnPick.addEventListener('click', async () => {
        try {
            const p = await api.image.pickSource();
            if (!p) return;
            sourcePath = p;
            sourceThumb.src = 'file://' + p;
            sourceThumb.classList.remove('hidden');
            sourceName.textContent = p.split(/[\\/]/).pop() || p;
        } catch (err) {
            setError(String(err?.message || err));
        }
    });

    async function submit() {
        if (busy) return;
        setError('');
        const prompt = promptInput.value.trim();
        if (!prompt) { setError('请输入图片描述'); return; }
        const model = currentModel();
        if (mode === 'edit' && !sourcePath) { setError('请先选择源图片'); return; }

        const opts = { prompt, model };
        if (isGeminiModel(model)) {
            // Gemini controls map to generationConfig.imageConfig.
            opts.aspectRatio = aspectSelect.value;
            opts.imageSize = gSizeSelect.value;
        } else {
            // size/quality/count only apply to the OpenAI images endpoint.
            opts.size = sizeSelect.value;
            opts.n = parseInt(countSelect.value, 10) || 1;
            // Only send quality for a concrete tier; `auto` is the default and
            // some models reject an explicit quality field.
            if (qualitySelect.value && qualitySelect.value !== 'auto') {
                opts.quality = qualitySelect.value;
            }
            // gpt-image extras; only send non-default values.
            if (bgSelect.value && bgSelect.value !== 'auto') opts.background = bgSelect.value;
            if (fmtSelect.value) opts.outputFormat = fmtSelect.value;
            if (fmtSelect.value === 'jpeg' || fmtSelect.value === 'webp') {
                const c = parseInt(compInput.value, 10);
                if (!Number.isNaN(c)) opts.outputCompression = Math.min(100, Math.max(0, c));
            }
            if (modSelect.value && modSelect.value !== 'auto') opts.moderation = modSelect.value;
        }

        setBusy(true);
        try {
            const res = mode === 'edit'
                ? await api.image.edit({ ...opts, imagePath: sourcePath })
                : await api.image.generate(opts);
            if (!res?.success) {
                setError(res?.error || '生成失败');
                return;
            }
            // Images are auto-saved server-side; reload the gallery from disk
            // so fresh results join the persisted history (newest first).
            await loadHistory();
        } catch (err) {
            setError(String(err?.message || err));
        } finally {
            setBusy(false);
        }
    }

    btnSubmit.addEventListener('click', submit);
    // Ctrl/Cmd+Enter in the prompt box submits.
    promptInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    });

    // Load persisted images and render them as the gallery.
    async function loadHistory() {
        try {
            const res = await api.image.history();
            renderGallery(res?.items || []);
        } catch (err) {
            // A history failure shouldn't break the panel; just show empty.
            renderGallery([]);
        }
    }

    // items: [{ path, url, mtime }]
    function renderGallery(items) {
        results.innerHTML = '';
        if (!items.length) {
            results.append(resultsEmpty);
            return;
        }
        const grid = el('div', 'image-grid');
        for (const item of items) {
            const card = el('div', 'image-card');
            const img = el('img', 'image-card-img');
            img.src = item.url;
            img.loading = 'lazy';
            img.title = '点击查看大图';
            // Click the thumbnail to open the full-resolution lightbox.
            img.addEventListener('click', () => openLightbox(item.url));

            const bar = el('div', 'image-card-bar');
            const btnReveal = el('button', 'image-card-btn', '在文件夹显示');
            const btnCopy = el('button', 'image-card-btn', '复制');
            bar.append(btnReveal, btnCopy);

            btnReveal.addEventListener('click', async () => {
                try {
                    const r = await api.image.reveal(item.path);
                    if (!r?.success) toast(r?.error || '打开失败', 'error');
                } catch (err) {
                    toast(String(err?.message || err), 'error');
                }
            });

            btnCopy.addEventListener('click', async () => {
                try {
                    const blob = await (await fetch(item.url)).blob();
                    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                    btnCopy.textContent = '已复制';
                    setTimeout(() => { btnCopy.textContent = '复制'; }, 1200);
                } catch (err) {
                    toast('复制失败：' + String(err?.message || err), 'error');
                }
            });

            card.append(img, bar);
            grid.append(card);
        }
        results.append(grid);
    }

    // ---- Lightbox (full-resolution preview) ----
    // A single overlay reused for every image. Click the backdrop or press
    // ESC to dismiss; the image itself shows at native resolution.
    const lightbox = el('div', 'image-lightbox hidden');
    const lightboxImg = el('img', 'image-lightbox-img');
    lightbox.append(lightboxImg);
    panel.append(lightbox);

    function openLightbox(url) {
        lightboxImg.src = url;
        lightbox.classList.remove('hidden');
    }
    function closeLightbox() {
        lightbox.classList.add('hidden');
        lightboxImg.src = '';
    }
    lightbox.addEventListener('click', closeLightbox);
    const onKeydown = (e) => {
        if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
    };
    document.addEventListener('keydown', onKeydown);

    // Show persisted history as soon as the panel mounts.
    loadHistory();

    return {
        destroy() {
            document.removeEventListener('keydown', onKeydown);
            panel.remove();
        },
    };
}
