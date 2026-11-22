import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import zlib from "node:zlib";

import { buildInstallPreview, downloadGithubSkill, downloadSkill, downloadUrlSkill, isPrivateAddress, parseGithubSkillUrl, parseSkillInstallUrl, SKILL_INSTALL_LIMITS, unzipSkill } from "./install.js";
import { SkillStore, SkillStoreError } from "./store.js";

const publicDns = async () => ["93.184.216.34"];
const skillMd = "---\nname: demo-skill\ndescription: 演示网络安装\n---\n\n运行 scripts/run.py。\n";

function fakeGithub(files: Record<string, string | number>, extra: Record<string, unknown> = {}) {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
        urls.push(url);
        if (url === "https://api.github.com/repos/acme/skills") return Response.json({ default_branch: "main" });
        if (url.startsWith("https://api.github.com/repos/acme/skills/git/trees/main")) {
            return Response.json({ truncated: false, ...extra, tree: [{ path: "skills", type: "tree" }, ...Object.entries(files).map(([file, value]) => ({ path: file, type: "blob", size: typeof value === "number" ? value : Buffer.byteLength(value) }))] });
        }
        const match = /^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/main\/(.+)$/.exec(url);
        const value = match ? files[decodeURIComponent(match[1])] : undefined;
        return typeof value === "string" ? new Response(value) : new Response("missing", { status: 404 });
    };
    return { fetcher, urls };
}

test("解析 GitHub Skill 链接", () => {
    assert.deepEqual(parseGithubSkillUrl("https://github.com/acme/skills"), { owner: "acme", repo: "skills", dir: "" });
    assert.deepEqual(parseGithubSkillUrl("https://github.com/acme/skills/tree/main/skills/demo"), { owner: "acme", repo: "skills", ref: "main", dir: "skills/demo" });
    assert.deepEqual(parseGithubSkillUrl("https://github.com/acme/skills/blob/v1/skills/demo/SKILL.md"), { owner: "acme", repo: "skills", ref: "v1", dir: "skills/demo" });
    for (const bad of ["http://github.com/acme/skills", "https://gitlab.com/acme/skills", "https://github.com/acme", "https://github.com/acme/skills/blob/main/README.md", "not a url"]) {
        assert.throws(() => parseGithubSkillUrl(bad), SkillStoreError, bad);
    }
});

test("下载目录、预览并安装到 .agents/skills", async (context) => {
    const { fetcher, urls } = fakeGithub({ "skills/demo/SKILL.md": skillMd, "skills/demo/scripts/run.py": "print(1)\n", "skills/other/SKILL.md": "x" });
    const source = parseGithubSkillUrl("https://github.com/acme/skills/tree/main/skills/demo");
    const { ref, files } = await downloadGithubSkill(source, fetcher);
    assert.equal(urls.some((url) => url.includes("skills/other")), false);
    const preview = buildInstallPreview(`acme/skills@${ref}/skills/demo`, files);
    assert.equal(preview.name, "demo-skill");
    assert.equal(preview.source, "acme/skills@main/skills/demo");
    assert.deepEqual(preview.files.map((file) => file.path), ["scripts/run.py", "SKILL.md"]);

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-install-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    const installed = await store.install(preview.payload);
    assert.equal(installed.name, "demo-skill");
    assert.equal(await fs.readFile(path.join(workspace, ".agents", "skills", "demo-skill", "scripts", "run.py"), "utf8"), "print(1)\n");
    await assert.rejects(store.install(preview.payload), (error: unknown) => error instanceof SkillStoreError && error.statusCode === 409);
});

test("仓库首页链接使用默认分支", async () => {
    const { fetcher } = fakeGithub({ "SKILL.md": skillMd });
    const { ref, files } = await downloadGithubSkill(parseGithubSkillUrl("https://github.com/acme/skills"), fetcher);
    assert.equal(ref, "main");
    assert.deepEqual(files.map((file) => file.path), ["SKILL.md"]);
});

test("超出文件数、单文件或总量上限时不下载文件内容", async () => {
    const source = parseGithubSkillUrl("https://github.com/acme/skills/tree/main/s");
    const many = Object.fromEntries([["s/SKILL.md", skillMd], ...Array.from({ length: SKILL_INSTALL_LIMITS.maxFiles }, (_, index) => [`s/f${index}.txt`, "x"])]);
    const cases: Array<[Record<string, string | number>, RegExp]> = [
        [many, /文件数/],
        [{ "s/SKILL.md": skillMd, "s/big.bin": SKILL_INSTALL_LIMITS.maxFileBytes + 1 }, /单文件上限/],
        [{ "s/SKILL.md": skillMd, ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`s/p${index}.bin`, SKILL_INSTALL_LIMITS.maxFileBytes])) }, /合计大小/],
        [{ "s/README.md": "x" }, /没有 SKILL\.md/],
        [{ "s/SKILL.md": skillMd, "s/.env": "secret" }, /不受支持/],
    ];
    for (const [files, pattern] of cases) {
        const { fetcher, urls } = fakeGithub(files);
        await assert.rejects(downloadGithubSkill(source, fetcher), (error: unknown) => error instanceof SkillStoreError && pattern.test(error.message));
        assert.equal(urls.some((url) => url.includes("raw.githubusercontent.com")), false);
    }
    const { fetcher } = fakeGithub({ "s/SKILL.md": skillMd }, { truncated: true });
    await assert.rejects(downloadGithubSkill(source, fetcher), /仓库文件过多/);
});

test("SKILL.md 缺少 name 或 description 时拒绝", async () => {
    const source = parseGithubSkillUrl("https://github.com/acme/skills/tree/main/s");
    const { fetcher } = fakeGithub({ "s/SKILL.md": "---\nname: demo\n---\n正文" });
    const { ref, files } = await downloadGithubSkill(source, fetcher);
    assert.throws(() => buildInstallPreview(ref, files), /description/);
});

test("拒绝会执行代码的 frontmatter，预览和安装都不执行", async (context) => {
    const flag = "__canvasSkillFrontmatterExecuted";
    const payloads = [
        `---js\n{ name: (globalThis.${flag} = 1, "evil-skill"), description: "x" }\n---\n正文\n`,
        `---javascript\n{ name: (globalThis.${flag} = 1, "evil-skill"), description: "x" }\n---\n正文\n`,
        `---JS\n{ name: (globalThis.${flag} = 1, "evil-skill"), description: "x" }\n---\n正文\n`,
    ];
    const source = parseGithubSkillUrl("https://github.com/acme/skills/tree/main/evil");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-evil-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const store = new SkillStore(workspace);
    for (const content of payloads) {
        const files = [{ path: "SKILL.md", content: Buffer.from(content) }];
        assert.throws(() => buildInstallPreview("main", files), /只支持 YAML/);
        await assert.rejects(store.install(files), /只支持 YAML/);
    }
    assert.equal((globalThis as Record<string, unknown>)[flag], undefined);
});

/** 生成测试用 zip；deflate 为 true 时压缩内容。 */
function makeZip(files: Record<string, string | Buffer>, deflate = true) {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, value] of Object.entries(files)) {
        const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const data = deflate ? zlib.deflateRawSync(content) : content;
        const nameBuffer = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(zlib.crc32(content), 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(zlib.crc32(content), 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuffer, data);
        centrals.push(central, nameBuffer);
        offset += local.length + nameBuffer.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

test("解析任意 https 链接，拒绝 http、本机和内网地址", () => {
    assert.equal(parseSkillInstallUrl("https://github.com/acme/skills").kind, "github");
    assert.equal(parseSkillInstallUrl("https://github.com/acme/skills/releases/download/v1/demo.zip").kind, "url");
    const source = parseSkillInstallUrl("https://example.com/skills/demo.zip");
    assert.equal(source.kind, "url");
    for (const bad of ["http://example.com/SKILL.md", "https://localhost/SKILL.md", "https://127.0.0.1/a.zip", "https://10.1.2.3/a.zip", "https://192.168.1.2/a.zip", "https://[::1]/a.zip", "https://[::ffff:127.0.0.1]/a.zip", "https://169.254.169.254/a.zip"]) {
        assert.throws(() => parseSkillInstallUrl(bad), SkillStoreError, bad);
    }
});

test("从 https 链接下载单个 SKILL.md", async () => {
    const source = parseSkillInstallUrl("https://example.com/demo/SKILL.md");
    const { location, files } = await downloadSkill(source, async () => new Response(skillMd), publicDns);
    assert.equal(location, "example.com/demo/SKILL.md");
    const preview = buildInstallPreview(location, files);
    assert.equal(preview.name, "demo-skill");
    assert.deepEqual(preview.files.map((file) => file.path), ["SKILL.md"]);
});

test("从 zip 中取出含 SKILL.md 的目录，跳过隐藏文件", async (context) => {
    const zip = makeZip({ "demo/": "", "demo/SKILL.md": skillMd, "demo/scripts/run.py": "print(1)\n", "demo/.DS_Store": "x", "__MACOSX/demo/._SKILL.md": "x", "README.md": "outside" });
    const files = await downloadUrlSkill(new URL("https://example.com/demo.zip"), async () => new Response(zip), publicDns);
    assert.deepEqual(files.map((file) => file.path).sort(), ["SKILL.md", "scripts/run.py"]);
    assert.equal(files.find((file) => file.path === "scripts/run.py")?.content.toString(), "print(1)\n");
    const stored = unzipSkill(makeZip({ "SKILL.md": skillMd }, false));
    assert.equal(stored[0].content.toString(), skillMd);

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-skill-zip-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const installed = await new SkillStore(workspace).install(buildInstallPreview("example.com/demo.zip", files).payload);
    assert.equal(installed.name, "demo-skill");
});

test("zip 超过上限、多个 SKILL.md 或大小不符时拒绝", () => {
    const many = Object.fromEntries(Array.from({ length: SKILL_INSTALL_LIMITS.maxFiles + 1 }, (_, index) => [`s/f${index}.txt`, "x"]));
    assert.throws(() => unzipSkill(makeZip({ "s/SKILL.md": skillMd, ...many })), /文件数/);
    assert.throws(() => unzipSkill(makeZip({ "SKILL.md": skillMd, "big.bin": Buffer.alloc(SKILL_INSTALL_LIMITS.maxFileBytes + 1) })), /单文件上限/);
    assert.throws(() => unzipSkill(makeZip({ "a/SKILL.md": skillMd, "b/SKILL.md": skillMd })), /多个 SKILL\.md/);
    assert.throws(() => unzipSkill(makeZip({ "README.md": "x" })), /没有 SKILL\.md/);
    // 目录里记录的大小比实际小（解压炸弹），解压时必须被截住。
    const bomb = makeZip({ "SKILL.md": skillMd, "data.txt": Buffer.alloc(200_000) });
    const index = bomb.lastIndexOf(Buffer.from("data.txt"));
    bomb.writeUInt32LE(10, index - 46 + 24);
    assert.throws(() => unzipSkill(bomb), /大小与记录不符/);
});

test("下载超过合计上限立即中止，重定向到内网被拒绝", async () => {
    const huge = new ReadableStream({
        pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
        },
    });
    await assert.rejects(downloadUrlSkill(new URL("https://example.com/huge.zip"), async () => new Response(huge), publicDns), /合计上限 5MB/);
    const redirect = async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/a.zip" } });
    await assert.rejects(downloadUrlSkill(new URL("https://example.com/a.zip"), redirect, publicDns), /本机或局域网/);
    let hops = 0;
    const chain = async (url: string) => (hops += 1, url.endsWith("/final") ? new Response(skillMd) : new Response(null, { status: 301, headers: { location: "/final" } }));
    const files = await downloadUrlSkill(new URL("https://example.com/start"), chain, publicDns);
    assert.equal(hops, 2);
    assert.equal(files[0].path, "SKILL.md");
});

test("域名解析到内网地址时拒绝下载，解析失败时交给代理", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "::1", "::ffff:192.168.1.1", "fd00::1", "169.254.169.254"]) assert.equal(isPrivateAddress(address), true, address);
    for (const address of ["93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateAddress(address), false, address);
    let fetched = 0;
    const fetcher = async () => (fetched += 1, new Response(skillMd));
    await assert.rejects(downloadUrlSkill(new URL("https://intranet.example.com/SKILL.md"), fetcher, async () => ["93.184.216.34", "10.0.0.5"]), /局域网/);
    assert.equal(fetched, 0);
    const redirect = async (url: string) => url.includes("public") ? new Response(null, { status: 302, headers: { location: "https://evil.example.com/SKILL.md" } }) : new Response(skillMd);
    await assert.rejects(downloadUrlSkill(new URL("https://public.example.com/a"), redirect, async (host) => host.startsWith("evil") ? ["127.0.0.1"] : ["93.184.216.34"]), /局域网/);
    const files = await downloadUrlSkill(new URL("https://proxy-only.example.com/SKILL.md"), fetcher, async () => { throw new Error("ENOTFOUND"); });
    assert.equal(files[0].path, "SKILL.md");
});
