import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

import type matter from "gray-matter";

import { parseSkillMarkdown, SkillStoreError } from "./store.js";

/** 用户确认的网络安装边界（2026-11-22）：支持 GitHub 和任意 https 的 SKILL.md 或 zip 链接；单个 Skill 最多 50 个文件、单文件 1MB、合计 5MB，下载 30 秒超时。 */
export const SKILL_INSTALL_LIMITS = { maxFiles: 50, maxFileBytes: 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024, timeoutMs: 30_000 } as const;

export type GithubSkillSource = { owner: string; repo: string; ref?: string; dir: string };
export type SkillInstallFile = { path: string; size: number; content: Buffer };
export type SkillInstallPreview = { id: string; name: string; description: string; source: string; instructions: string; files: Array<{ path: string; size: number }>; totalSize: number };
export type SkillInstallSource = { kind: "github"; github: GithubSkillSource } | { kind: "url"; url: URL };
/** 解析域名得到全部 IP；测试中可替换。 */
export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((item) => item.address);
type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect?: RequestRedirect }) => Promise<Response>;

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "canvas-agent" };
const FILE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_REDIRECTS = 5;

/** 判断链接类型：github.com 按仓库目录下载，其他 https 链接按 SKILL.md 或 zip 下载。 */
export function parseSkillInstallUrl(value: unknown): SkillInstallSource {
    let url: URL;
    try {
        url = new URL(String(value || "").trim());
    } catch {
        throw new SkillStoreError("请输入 Skill 链接", 400);
    }
    if (url.protocol !== "https:") throw new SkillStoreError("只支持 https 链接", 400);
    // GitHub 的源码压缩包和 Release 附件（.zip）按普通 zip 链接下载。
    if (url.hostname === "github.com" && !url.pathname.toLowerCase().endsWith(".zip")) return { kind: "github", github: parseGithubSkillUrl(url.href) };
    assertPublicHost(url);
    return { kind: "url", url };
}

/** 按链接类型下载 Skill 文件，返回来源说明和文件列表。 */
export async function downloadSkill(source: SkillInstallSource, fetcher: Fetcher = fetch, resolve: Resolver = defaultResolver) {
    if (source.kind === "github") {
        const { ref, files } = await downloadGithubSkill(source.github, fetcher);
        const { owner, repo, dir } = source.github;
        return { location: `${owner}/${repo}@${ref}${dir ? `/${dir}` : ""}`, files };
    }
    return { location: `${source.url.host}${source.url.pathname}`, files: await downloadUrlSkill(source.url, fetcher, resolve) };
}

/**
 * 下载任意 https 链接：内容是 zip 时解压出含 SKILL.md 的目录，否则当作 SKILL.md 本身。
 * 边界与 GitHub 相同；下载过程中超过合计上限立即中止，zip 按目录记录的大小先检查再解压。
 */
export async function downloadUrlSkill(url: URL, fetcher: Fetcher = fetch, resolve: Resolver = defaultResolver, signal: AbortSignal = AbortSignal.timeout(SKILL_INSTALL_LIMITS.timeoutMs)): Promise<SkillInstallFile[]> {
    let current = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertPublicDestination(current, resolve, signal);
        response = await request(fetcher, current.href, signal, { "user-agent": "canvas-agent" }, "manual", "下载地址");
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) throw new SkillStoreError("下载地址重定向过多或无效", 409);
        current = new URL(location, current);
        if (current.protocol !== "https:") throw new SkillStoreError("下载地址重定向到了非 https 链接", 400);
    }
    const body = await readLimited(response!, SKILL_INSTALL_LIMITS.maxTotalBytes, signal);
    if (body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return unzipSkill(body);
    if (body.length > SKILL_INSTALL_LIMITS.maxFileBytes) throw new SkillStoreError("SKILL.md 超过单文件上限 1MB", 400);
    return [{ path: "SKILL.md", size: body.length, content: body }];
}

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
export function buildInstallPreview(location: string, files: SkillInstallFile[]): SkillInstallPreview & { payload: SkillInstallFile[] } {
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

async function request(fetcher: Fetcher, url: string, signal: AbortSignal, headers: Record<string, string> = HEADERS, redirect: RequestRedirect = "follow", target = "GitHub") {
    let response: Response;
    try {
        response = await fetcher(url, { signal, headers, redirect });
    } catch (error) {
        if (signal.aborted) throw new SkillStoreError("下载超时（30 秒），请稍后重试", 409);
        throw new SkillStoreError(`无法连接${target}：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    if (redirect === "manual" && response.status >= 300 && response.status < 400) return response;
    if (response.status === 404) throw new SkillStoreError(target === "GitHub" ? "找不到该仓库、分支或目录，请确认链接是公开的" : "下载地址不存在（404）", 404);
    if (response.status === 403 || response.status === 429) throw new SkillStoreError(`${target}拒绝了请求，可能需要登录或触发了访问频率限制，请稍后再试`, 409);
    if (!response.ok) throw new SkillStoreError(`${target}返回错误 ${response.status}`, 409);
    return response;
}

/** 读取响应正文，超过上限立即中止下载。 */
async function readLimited(response: Response, limit: number, signal: AbortSignal) {
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > limit) throw new SkillStoreError("下载内容超过合计上限 5MB", 400);
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > limit) {
                await reader.cancel().catch(() => undefined);
                throw new SkillStoreError("下载内容超过合计上限 5MB", 400);
            }
            chunks.push(Buffer.from(value));
        }
    } catch (error) {
        if (error instanceof SkillStoreError) throw error;
        if (signal.aborted) throw new SkillStoreError("下载超时（30 秒），请稍后重试", 409);
        throw new SkillStoreError(`下载中断：${error instanceof Error ? error.message : String(error)}`, 409);
    }
    return Buffer.concat(chunks);
}

const BLOCKED_ADDRESSES = (() => {
    const list = new net.BlockList();
    ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3"].forEach((range) => {
        const [address, prefix] = range.split("/");
        list.addSubnet(address, Number(prefix), "ipv4");
    });
    ["::/127", "fc00::/7", "fe80::/10", "ff00::/8"].forEach((range) => {
        const [address, prefix] = range.split("/");
        list.addSubnet(address, Number(prefix), "ipv6");
    });
    return list;
})();

/** 判断 IP 是否属于本机、内网、链路本地或组播地址；IPv4 映射的 IPv6 地址按 IPv4 判断。 */
export function isPrivateAddress(address: string) {
    const value = address.replace(/^\[|\]$/g, "").toLowerCase();
    const version = net.isIP(value);
    if (!version) return false;
    const mapped = version === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1] : undefined;
    return mapped ? BLOCKED_ADDRESSES.check(mapped, "ipv4") : BLOCKED_ADDRESSES.check(value, version === 4 ? "ipv4" : "ipv6");
}

/** 只允许公网地址，避免借安装链接访问本机或内网服务。 */
function assertPublicHost(url: URL) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isPrivateAddress(host)) throw new SkillStoreError("不能从本机或局域网地址安装 Skill", 400);
}

/**
 * 每次请求前（包括每一跳重定向）检查域名解析结果，任何一个地址落在内网就拒绝。
 * 本机无法解析（例如只能经代理上网）时放行，由代理去解析；解析和实际连接之间的 DNS 重绑定这里防不住。
 */
async function assertPublicDestination(url: URL, resolve: Resolver, signal: AbortSignal) {
    assertPublicHost(url);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) return;
    let addresses: string[];
    try {
        // 解析也计入 30 秒下载时限，解析卡住时按超时返回。
        addresses = await new Promise<string[]>((resolvePromise, reject) => {
            if (signal.aborted) return reject(signal.reason);
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            resolve(host).then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
        });
    } catch {
        if (signal.aborted) throw new SkillStoreError("下载超时（30 秒），请稍后重试", 409);
        return;
    }
    if (addresses.some(isPrivateAddress)) throw new SkillStoreError(`域名 ${host} 指向本机或局域网地址，不能从这里安装 Skill`, 400);
}

type ZipEntry = { name: string; method: number; flags: number; compressedSize: number; size: number; offset: number };

/** 解压 zip 中唯一一个含 SKILL.md 的目录；先按目录记录检查数量和大小，再逐个解压并核对实际大小。 */
export function unzipSkill(archive: Buffer): SkillInstallFile[] {
    const entries = readZipEntries(archive).filter((entry) => !entry.name.endsWith("/"));
    const skillFiles = entries.filter((entry) => entry.name === "SKILL.md" || entry.name.endsWith("/SKILL.md"));
    if (!skillFiles.length) throw new SkillStoreError("zip 中没有 SKILL.md", 400);
    if (skillFiles.length > 1) throw new SkillStoreError("zip 中有多个 SKILL.md，请只打包一个 Skill", 400);
    const prefix = skillFiles[0].name.slice(0, -"SKILL.md".length);
    const selected = entries
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.name.slice(prefix.length) }))
        // 跳过打包工具常带的隐藏文件和 __MACOSX 目录。
        .filter((entry) => !entry.path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX"));
    if (selected.length > SKILL_INSTALL_LIMITS.maxFiles) throw new SkillStoreError(`Skill 文件数 ${selected.length} 超过上限 ${SKILL_INSTALL_LIMITS.maxFiles}`, 400);
    const tooLarge = selected.find((entry) => entry.size > SKILL_INSTALL_LIMITS.maxFileBytes);
    if (tooLarge) throw new SkillStoreError(`文件 ${tooLarge.path} 超过单文件上限 1MB`, 400);
    if (selected.reduce((sum, entry) => sum + entry.size, 0) > SKILL_INSTALL_LIMITS.maxTotalBytes) throw new SkillStoreError("Skill 合计大小超过上限 5MB", 400);
    const invalid = selected.find((entry) => entry.path.split("/").some((part) => !FILE_SEGMENT.test(part)));
    if (invalid) throw new SkillStoreError(`文件名 ${invalid.path} 不受支持（只能包含字母、数字、点、下划线和连字符，不能以点开头）`, 400);
    return selected.map((entry) => {
        const content = readZipEntry(archive, entry);
        return { path: entry.path, size: content.length, content };
    });
}

function readZipEntries(archive: Buffer): ZipEntry[] {
    const end = findEndOfCentralDirectory(archive);
    const count = archive.readUInt16LE(end + 10);
    let offset = archive.readUInt32LE(end + 16);
    if (count === 0xffff || offset === 0xffffffff) throw new SkillStoreError("不支持 zip64 压缩包", 400);
    const entries: ZipEntry[] = [];
    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new SkillStoreError("zip 文件已损坏", 400);
        const nameLength = archive.readUInt16LE(offset + 28);
        const extraLength = archive.readUInt16LE(offset + 30);
        const commentLength = archive.readUInt16LE(offset + 32);
        entries.push({
            flags: archive.readUInt16LE(offset + 8),
            method: archive.readUInt16LE(offset + 10),
            compressedSize: archive.readUInt32LE(offset + 20),
            size: archive.readUInt32LE(offset + 24),
            offset: archive.readUInt32LE(offset + 42),
            name: archive.toString("utf8", offset + 46, offset + 46 + nameLength).replace(/\\/g, "/"),
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    if (entries.length > SKILL_INSTALL_LIMITS.maxFiles * 4) throw new SkillStoreError(`zip 中的条目过多（${entries.length}），请只打包一个 Skill`, 400);
    return entries;
}

function findEndOfCentralDirectory(archive: Buffer) {
    for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 22 - 0xffff); offset -= 1) {
        if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new SkillStoreError("zip 文件已损坏", 400);
}

function readZipEntry(archive: Buffer, entry: ZipEntry & { path: string }) {
    if (entry.flags & 0x1) throw new SkillStoreError(`文件 ${entry.path} 已加密，无法安装`, 400);
    const header = entry.offset;
    if (header + 30 > archive.length || archive.readUInt32LE(header) !== 0x04034b50) throw new SkillStoreError("zip 文件已损坏", 400);
    const start = header + 30 + archive.readUInt16LE(header + 26) + archive.readUInt16LE(header + 28);
    const data = archive.subarray(start, start + entry.compressedSize);
    if (data.length !== entry.compressedSize) throw new SkillStoreError("zip 文件已损坏", 400);
    let content: Buffer;
    if (entry.method === 0) content = Buffer.from(data);
    else if (entry.method === 8) {
        try {
            content = zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
        } catch {
            throw new SkillStoreError(`文件 ${entry.path} 解压失败或实际大小与记录不符`, 400);
        }
    } else throw new SkillStoreError(`文件 ${entry.path} 使用了不支持的压缩方式`, 400);
    if (content.length !== entry.size) throw new SkillStoreError(`文件 ${entry.path} 实际大小与记录不符`, 400);
    return content;
}
