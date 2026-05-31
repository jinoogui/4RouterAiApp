import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigStore } from './config-store';

const FALLBACK_BASE_URL = 'https://api.dshub.top/v1';
const REQUEST_TIMEOUT_MS = 120000; // image generation is slow; allow 120s

/** A model name routes to the Gemini engine when it starts with "gemini". */
function isGeminiModel(model: string): boolean {
    return /^gemini/i.test((model || '').trim());
}

export interface GenerateOptions {
    prompt: string;
    model: string;
    size?: string;              // OpenAI: e.g. "1024x1024" | "auto"
    n?: number;                 // OpenAI: number of images, 1-4
    quality?: string;           // OpenAI: high | medium | low | auto
    background?: string;        // OpenAI(gpt-image): transparent | opaque | auto
    outputFormat?: string;      // OpenAI(gpt-image): png | jpeg | webp
    outputCompression?: number; // OpenAI(gpt-image): 0-100, jpeg/webp only
    moderation?: string;        // OpenAI(gpt-image): auto | low
    aspectRatio?: string;       // Gemini: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" ...
    imageSize?: string;         // Gemini: "1K" | "2K" | "4K"
}

export interface EditOptions extends GenerateOptions {
    imagePath: string;    // local file path to the source image
}

export interface ImageResult {
    success: boolean;
    images?: string[];    // data URLs (data:image/png;base64,...)
    error?: string;
}

/**
 * ImageGenerator
 * Standalone image-generation module. Talks to the OpenAI-compatible
 * gateway (api.dshub.top) using the already-provisioned `openai` key —
 * the same Bearer scheme as KeyProvisioner/AccountManager, but pointed at
 * the /v1/images/* endpoints. No `New-Api-User` header is needed for the
 * OpenAI-compatible proxy routes.
 *
 * Text-to-image  → POST /images/generations (JSON)
 * Image-to-image → POST /images/edits        (multipart/form-data)
 *
 * Both endpoints return either b64_json or a url per image; we normalize
 * everything to a data URL so the renderer can display and save uniformly.
 */
export class ImageGenerator {
    constructor(private readonly configStore: ConfigStore) {}

    /**
     * Base URL without trailing slash; falls back to the gateway default.
     * The endpoints below append "/images/...", so the base must end in the
     * OpenAI "/v1" segment. If a manually-configured base omits it (e.g. just
     * "https://api.dshub.top"), append "/v1" so the path resolves correctly.
     */
    private getBaseUrl(): string {
        const stored = this.configStore.getBaseUrl('openai');
        let base = ((stored && stored.trim()) || FALLBACK_BASE_URL).replace(/\/+$/, '');
        if (!/\/v\d+$/.test(base)) base += '/v1';
        return base;
    }

    /** Text-to-image. Routes to Gemini or the OpenAI endpoint by model name. */
    async generate(apiKey: string, opts: GenerateOptions): Promise<ImageResult> {
        const prompt = (opts.prompt || '').trim();
        if (!prompt) return { success: false, error: '请输入图片描述' };

        if (isGeminiModel(opts.model)) {
            return this.generateGemini(apiKey, opts);
        }

        const body: Record<string, any> = {
            model: opts.model,
            prompt,
            n: clampCount(opts.n),
        };
        if (opts.size && opts.size !== 'auto') body.size = opts.size;
        if (opts.quality) body.quality = opts.quality;
        // gpt-image-specific extras; only sent when explicitly chosen.
        if (opts.background && opts.background !== 'auto') body.background = opts.background;
        if (opts.outputFormat) body.output_format = opts.outputFormat;
        if (typeof opts.outputCompression === 'number'
            && (opts.outputFormat === 'jpeg' || opts.outputFormat === 'webp')) {
            body.output_compression = opts.outputCompression;
        }
        if (opts.moderation && opts.moderation !== 'auto') body.moderation = opts.moderation;

        try {
            const json = await this.httpPostJson('/images/generations', apiKey, body);
            return await this.normalizeResponse(json);
        } catch (err: any) {
            return { success: false, error: err?.message || '生成图片失败' };
        }
    }

    /** Image-to-image (edit / variation with a prompt). */
    async edit(apiKey: string, opts: EditOptions): Promise<ImageResult> {
        const prompt = (opts.prompt || '').trim();
        if (!prompt) return { success: false, error: '请输入图片描述' };
        if (!opts.imagePath || !fs.existsSync(opts.imagePath)) {
            return { success: false, error: '请选择有效的源图片' };
        }

        if (isGeminiModel(opts.model)) {
            return this.generateGemini(apiKey, opts, opts.imagePath);
        }

        const fields: Record<string, string> = {
            model: opts.model,
            prompt,
            n: String(clampCount(opts.n)),
        };
        if (opts.size && opts.size !== 'auto') fields.size = opts.size;
        if (opts.quality) fields.quality = opts.quality;
        // gpt-image extras (same set as generate, expressed as form fields).
        if (opts.background && opts.background !== 'auto') fields.background = opts.background;
        if (opts.outputFormat) fields.output_format = opts.outputFormat;
        if (typeof opts.outputCompression === 'number'
            && (opts.outputFormat === 'jpeg' || opts.outputFormat === 'webp')) {
            fields.output_compression = String(opts.outputCompression);
        }
        if (opts.moderation && opts.moderation !== 'auto') fields.moderation = opts.moderation;

        try {
            const buf = fs.readFileSync(opts.imagePath);
            const filename = path.basename(opts.imagePath) || 'image.png';
            const json = await this.httpPostMultipart(
                '/images/edits',
                apiKey,
                fields,
                { name: 'image', filename, data: buf }
            );
            return await this.normalizeResponse(json);
        } catch (err: any) {
            return { success: false, error: err?.message || '图生图失败' };
        }
    }

    /**
     * Turn an OpenAI images response into an array of data URLs.
     * Each item carries either `b64_json` (preferred) or a `url` we must
     * fetch and inline. An upstream error body becomes a failed result.
     */
    private async normalizeResponse(json: any): Promise<ImageResult> {
        // TEMP debug: surface the raw gateway response so we can confirm the
        // model name and the actual data shape. Truncated to avoid huge b64 dumps.
        try {
            const preview = JSON.stringify(json);
            console.log('[ImageGenerator] raw response:', preview.length > 800 ? preview.slice(0, 800) + '…(truncated)' : preview);
        } catch { /* ignore */ }

        if (json?.error) {
            const msg = typeof json.error === 'string' ? json.error : json.error.message;
            return { success: false, error: msg || '生成图片失败' };
        }
        const data: any[] = Array.isArray(json?.data) ? json.data : [];
        if (data.length === 0) {
            // Some gateways tuck a top-level message here when nothing was produced.
            const hint = json?.message || json?.msg;
            return { success: false, error: hint ? `网关未返回图片数据：${hint}` : '网关未返回图片数据' };
        }

        const images: string[] = [];
        for (const item of data) {
            if (item?.b64_json) {
                images.push(`data:image/png;base64,${item.b64_json}`);
            } else if (item?.url) {
                try {
                    images.push(await this.fetchAsDataUrl(item.url));
                } catch {
                    /* skip an unreachable image rather than failing the whole batch */
                }
            }
        }
        if (images.length === 0) {
            return { success: false, error: '图片解析失败（无 b64_json/url）' };
        }
        return { success: true, images };
    }

    /**
     * Gemini image generation via /v1beta/models/{model}:generateContent.
     * Completely different shape from the OpenAI endpoint: the prompt (and an
     * optional source image for image-to-image) go into contents[].parts[],
     * and generated images come back as inlineData parts. size/quality/n have
     * no equivalent here, so they're ignored.
     */
    private async generateGemini(apiKey: string, opts: GenerateOptions, imagePath?: string): Promise<ImageResult> {
        const parts: any[] = [{ text: opts.prompt.trim() }];

        // Image-to-image: inline the source image as a base64 part.
        if (imagePath) {
            try {
                const buf = fs.readFileSync(imagePath);
                parts.push({
                    inlineData: {
                        mimeType: guessImageMime(path.basename(imagePath)),
                        data: buf.toString('base64'),
                    },
                });
            } catch (err: any) {
                return { success: false, error: `读取源图片失败：${err?.message || err}` };
            }
        }

        // Gemini's image controls live under generationConfig.imageConfig.
        // Only include fields the user actually set so older models that don't
        // understand them aren't sent unexpected keys.
        const imageConfig: Record<string, string> = {};
        if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio;
        if (opts.imageSize) imageConfig.imageSize = opts.imageSize;

        const generationConfig: Record<string, any> = { responseModalities: ['TEXT', 'IMAGE'] };
        if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;

        const body = {
            contents: [{ parts }],
            generationConfig,
        };

        const apiPath = `/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
        try {
            const json = await this.requestGemini(apiPath, apiKey, Buffer.from(JSON.stringify(body)));
            return this.normalizeGeminiResponse(json);
        } catch (err: any) {
            return { success: false, error: err?.message || '生成图片失败' };
        }
    }

    /** Extract inlineData image parts from a Gemini generateContent response. */
    private normalizeGeminiResponse(json: any): ImageResult {
        try {
            const preview = JSON.stringify(json);
            console.log('[ImageGenerator] gemini raw:', preview.length > 600 ? preview.slice(0, 600) + '…(truncated)' : preview);
        } catch { /* ignore */ }

        if (json?.error) {
            const msg = typeof json.error === 'string' ? json.error : json.error.message;
            return { success: false, error: msg || '生成图片失败' };
        }

        const candidates: any[] = Array.isArray(json?.candidates) ? json.candidates : [];
        const images: string[] = [];
        let textNote = '';
        for (const cand of candidates) {
            const cparts: any[] = cand?.content?.parts || [];
            for (const p of cparts) {
                const inline = p?.inlineData || p?.inline_data;
                if (inline?.data) {
                    const mime = inline.mimeType || inline.mime_type || 'image/png';
                    images.push(`data:${mime};base64,${inline.data}`);
                } else if (p?.text) {
                    textNote = p.text;
                }
            }
        }
        if (images.length === 0) {
            // Often a safety block or text-only reply; surface any explanatory text.
            const block = json?.promptFeedback?.blockReason;
            const hint = block ? `（${block}）` : textNote ? `：${textNote.slice(0, 120)}` : '';
            return { success: false, error: `模型未返回图片${hint}` };
        }
        return { success: true, images };
    }

    /**
     * POST to the Gemini generateContent endpoint. The gateway shares the host
     * with the OpenAI base, but Gemini paths live at the root (/v1beta/...),
     * not under /v1 — so derive the host from the OpenAI base and drop /v1.
     */
    private requestGemini(apiPath: string, apiKey: string, payload: Buffer): Promise<any> {
        const openaiBase = this.getBaseUrl();              // e.g. https://api.dshub.top/v1
        const root = openaiBase.replace(/\/v\d+$/, '');    // -> https://api.dshub.top
        return new Promise((resolve, reject) => {
            const url = new URL(`${root}${apiPath}`);
            console.log(`[ImageGenerator] POST(gemini) ${url.href} (payload ${payload.length} bytes)`);
            const req = https.request(
                {
                    hostname: url.hostname,
                    port: url.port || 443,
                    path: url.pathname + url.search,
                    method: 'POST',
                    headers: {
                        // The gateway accepts the bearer key; also send Google's
                        // native header so it works whichever the proxy expects.
                        Authorization: `Bearer ${apiKey}`,
                        'x-goog-api-key': apiKey,
                        'Content-Type': 'application/json',
                        'Content-Length': String(payload.length),
                        Accept: 'application/json',
                    },
                },
                (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => {
                        const status = res.statusCode || 0;
                        console.log(`[ImageGenerator] gemini status=${status}, body: ${data.slice(0, 400)}`);
                        let parsed: any = null;
                        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
                        if (status < 200 || status >= 300) {
                            const gwMsg = parsed?.error?.message || parsed?.error || parsed?.message || data.slice(0, 200);
                            reject(new Error(`网关返回 ${status}：${gwMsg || '未知错误'}`));
                            return;
                        }
                        if (parsed === null) { reject(new Error(`网关响应解析失败: ${data.slice(0, 200)}`)); return; }
                        resolve(parsed);
                    });
                }
            );
            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('请求超时（生成图片耗时较长，请重试）')); });
            req.write(payload);
            req.end();
        });
    }

    /** GET an image URL and inline it as a base64 data URL. */
    private fetchAsDataUrl(absUrl: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(absUrl);
            const req = https.request(
                {
                    hostname: url.hostname,
                    port: url.port || 443,
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        const mime = res.headers['content-type'] || 'image/png';
                        resolve(`data:${mime};base64,${buf.toString('base64')}`);
                    });
                }
            );
            req.on('error', (err) => reject(new Error(`图片下载失败: ${err.message}`)));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('图片下载超时')); });
            req.end();
        });
    }

    /** POST a JSON body to {baseUrl}{path} with Bearer auth; parse JSON reply. */
    private httpPostJson(apiPath: string, apiKey: string, body: any): Promise<any> {
        const bodyStr = JSON.stringify(body);
        return this.request(apiPath, apiKey, {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(bodyStr)),
        }, Buffer.from(bodyStr));
    }

    /**
     * POST multipart/form-data with one file part + text fields.
     * Hand-built so we don't pull in a form-data dependency.
     */
    private httpPostMultipart(
        apiPath: string,
        apiKey: string,
        fields: Record<string, string>,
        file: { name: string; filename: string; data: Buffer }
    ): Promise<any> {
        const boundary = '----TokenWaveImage' + Buffer.from(file.filename).toString('hex').slice(0, 16);
        const CRLF = '\r\n';
        const parts: Buffer[] = [];

        for (const [key, value] of Object.entries(fields)) {
            parts.push(Buffer.from(
                `--${boundary}${CRLF}` +
                `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
                `${value}${CRLF}`
            ));
        }
        const mime = guessImageMime(file.filename);
        parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${CRLF}` +
            `Content-Type: ${mime}${CRLF}${CRLF}`
        ));
        parts.push(file.data);
        parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));

        const payload = Buffer.concat(parts);
        return this.request(apiPath, apiKey, {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(payload.length),
        }, payload);
    }

    /** Shared HTTPS POST: writes `payload`, returns parsed JSON. */
    private request(apiPath: string, apiKey: string, headers: Record<string, string>, payload: Buffer): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.getBaseUrl()}${apiPath}`);
            console.log(`[ImageGenerator] POST ${url.href} (payload ${payload.length} bytes)`);
            const reqOptions: https.RequestOptions = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                    ...headers,
                },
            };
            const req = https.request(reqOptions, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    const status = res.statusCode || 0;
                    console.log(`[ImageGenerator] response status=${status}, body: ${data.slice(0, 600)}`);
                    let parsed: any = null;
                    try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }

                    // Non-2xx: surface the gateway's own message instead of a
                    // generic parse error, so the user sees the real cause.
                    if (status < 200 || status >= 300) {
                        const gwMsg = parsed?.error?.message || parsed?.error || parsed?.message || data.slice(0, 200);
                        reject(new Error(`网关返回 ${status}：${gwMsg || '未知错误'}`));
                        return;
                    }
                    if (parsed === null) {
                        reject(new Error(`网关响应解析失败: ${data.slice(0, 200)}`));
                        return;
                    }
                    resolve(parsed);
                });
            });
            req.on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
            req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('请求超时（生成图片耗时较长，请重试）')); });
            req.write(payload);
            req.end();
        });
    }
}

/** Clamp the requested image count to a sane 1-4 range. */
function clampCount(n: number | undefined): number {
    const v = Math.floor(Number(n) || 1);
    return Math.min(4, Math.max(1, v));
}

/** Best-effort MIME from a filename extension for the multipart file part. */
function guessImageMime(filename: string): string {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    switch (ext) {
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'webp': return 'image/webp';
        case 'gif': return 'image/gif';
        default: return 'image/png';
    }
}
