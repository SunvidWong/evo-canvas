import crypto from "node:crypto";

import type matter from "gray-matter";

import { parseSkillMarkdown, SkillStoreError } from "./store.js";

/** 用户确认的网络安装边界（2026-11-22）：只支持 GitHub；单个 Skill 最多 50 个文件、单文件 1MB、合计 5MB，下载 30 秒超时。 */
export const SKILL_INSTALL_LIMITS = { maxFiles: 50, maxFileBytes: 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, timeoutMs: 30_000 } as const;

export type GithubSkillSource = { owner: string; repo: string; ref?: string; dir: string };
export type SkillInstallFile = { path: string; size: number; content: Buffer };
export type SkillInstallPreview = { id: string; name: string; description: string; source: string; instructions: string; files: Array<{ path: string; size: number }>; totalSize: number };
type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "canvas-agent" };

/** 解析 GitHub 链接：仓库根、/tree/<分支>/<目录>，或 /blob/<分支>/<目录>/SKILL.md。分支名不能包含 /。 */
export function parseGithubSkillUrl(value: unknown): GithubSkillSource {
    let url: URL;
    try {
        url = new URL(String(value || "").trim());
    } catch {
        throw new SkillStoreError("请输入 GitHub 链接", 400);
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com") throw new SkillStoreError("目前只支持 https://github.com 上的 Skill", 400);
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const [owner, rawRepo, kind, ref, ...rest] = parts;
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo || ![owner, repo].every((part) => SEGMENT.test(part))) throw new SkillStoreError("GitHub 链接缺少仓库名", 400);
    if (!kind) return { owner, repo, dir: "" };
    if ((kind !== "tree" && kind !== "blob") || !ref || !SEGMENT.test(ref)) throw new SkillStoreError("请使用仓库首页、目录（/tree/分支/目录）或 SKILL.md（/blob/分支/…/SKILL.md）链接", 400);
    if (kind === "blob" && rest.at(-1)?.toLowerCase() !== "skill.md") throw new SkillStoreError("文件链接必须指向 SKILL.md", 400);
    const dirParts = kind === "blob" ? rest.slice(0, -1) : rest;
    if (dirParts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) throw new SkillStoreError("GitHub 链接中的目录无效", 400);
    return { owner, repo, ref, dir: dirParts.join("/") };
}

/** 从 GitHub 下载一个 Skill 目录；先按目录树检查文件数和大小，超限直接拒绝，不下载。 */
export async function downloadGithubSkill(source: GithubSkillSource, fetcher: Fetcher = fetch) {
    const signal = AbortSignal.timeout(SKILL_INSTALL_LIMITS.timeoutMs);
    const getJson = async (url: string) => {
        const response = await request(fetcher, url, signal);
        return await response.json() as Record<string, unknown>;
    };
    const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
    const ref = source.ref || String((await getJson(api)).default_branch || "");
    if (!ref) throw new SkillStoreError("无法确定仓库默认分支", 409);
    const tree = await getJson(`${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (tree.truncated) throw new SkillStoreError("仓库文件过多，请填写 Skill 所在目录的链接", 400);
    const prefix = source.dir ? `${source.dir}/` : "";
    const entries = (Array.isArray(tree.tree) ? tree.tree : [])
        .filter((item): item is { path: string; type: string; size?: number } => Boolean(item) && typeof item.path === "string" && item.type === "blob" && item.path.startsWith(prefix))
        .map((item) => ({ path: item.path.slice(prefix.length), size: Number(item.size) || 0 }));
    if (!entries.some((item) => item.path === "SKILL.md")) throw new SkillStoreError("该目录下没有 SKILL.md", 400);
    if (entries.length > SKILL_INSTALL_LIMITS.maxFiles) throw new SkillStoreError(`Skill 文件数 ${entries.length} 超过上限 ${SKILL_INSTALL_LIMITS.maxFiles}`, 400);
    const tooLarge = entries.find((item) => item.size > SKILL_INSTALL_LIMITS.maxFileBytes);
    if (tooLarge) throw new SkillStoreError(`文件 ${tooLarge.path} 超过单文件上限 1MB`, 400);
    if (entries.reduce((sum, item) => sum + item.size, 0) > SKILL_INSTALL_LIMITS.maxTotalBytes) throw new SkillStoreError("Skill 合计大小超过上限 5MB", 400);
    const invalid = entries.find((item) => item.path.split("/").some((part) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part)));
    if (invalid) throw new SkillStoreError(`文件名 ${invalid.path} 不受支持（只能包含字母、数字、点、下划线和连字符，不能以点开头）`, 400);
    const files: SkillInstallFile[] = [];
    for (const entry of entries) {
        const response = await request(fetcher, `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(ref)}/${[...prefix.split("/").filter(Boolean), ...entry.path.split("/")].map(encodeURIComponent).join("/")}`, signal);
        const content = Buffer.from(await response.arrayBuffer());
        if (content.length > SKILL_INSTALL_LIMITS.maxFileBytes) throw new SkillStoreError(`文件 ${entry.path} 超过单文件上限 1MB`, 400);
        files.push({ path: entry.path, size: content.length, content });
    }
    if (files.reduce((sum, item) => sum + item.size, 0) > SKILL_INSTALL_LIMITS.maxTotalBytes) throw new SkillStoreError("Skill 合计大小超过上限 5MB", 400);
    return { ref, files };
}

/** 校验下载到的 SKILL.md 并生成预览；正文和文件内容保存在内存中，安装时按 id 取用。 */
export function buildInstallPreview(source: GithubSkillSource, ref: string, files: SkillInstallFile[]): SkillInstallPreview & { payload: SkillInstallFile[] } {
    const skillFile = files.find((item) => item.path === "SKILL.md");
    if (!skillFile) throw new SkillStoreError("该目录下没有 SKILL.md", 400);
    let parsed: matter.GrayMatterFile<string>;
    try {
        parsed = parseSkillMarkdown(skillFile.content.toString("utf8"));
    } catch {
        throw new SkillStoreError("SKILL.md frontmatter 格式无效，只支持 YAML", 400);
    }
    const name = typeof parsed.data.name === "string" ? parsed.data.name : "";
    const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
    if (!name) throw new SkillStoreError("SKILL.md 缺少 name", 400);
    if (!description) throw new SkillStoreError("SKILL.md 缺少 description", 400);
    const location = `${source.owner}/${source.repo}@${ref}${source.dir ? `/${source.dir}` : ""}`;
    return {
        id: crypto.randomUUID(),
        name,
        description,
        source: location,
        instructions: parsed.content.trim(),
        files: files.map(({ path, size }) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path)),
        totalSize: files.reduce((sum, item) => sum + item.size, 0),
        payload: files,
    };
}

async function request(fetcher: Fetcher, url: string, signal: AbortSignal) {
    let response: Response;
    try {
        response = await fetcher(url, { signal, headers: HEADERS });
    } catch (error) {
        if (signal.aborted) throw new SkillStoreError("下载超时（30 秒），请稍后重试", 409);
        throw new SkillStoreError(`无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (response.status === 404) throw new SkillStoreError("找不到该仓库、分支或目录，请确认链接是公开的", 404);
    if (response.status === 403 || response.status === 429) throw new SkillStoreError("GitHub 拒绝了请求，可能触发了访问频率限制，请稍后再试", 409);
    if (!response.ok) throw new SkillStoreError(`GitHub 返回错误 ${response.status}`, 409);
    return response;
}
