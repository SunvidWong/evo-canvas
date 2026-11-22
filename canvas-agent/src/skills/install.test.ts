import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildInstallPreview, downloadGithubSkill, parseGithubSkillUrl, SKILL_INSTALL_LIMITS } from "./install.js";
import { SkillStore, SkillStoreError } from "./store.js";

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
    const preview = buildInstallPreview(source, ref, files);
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
    assert.throws(() => buildInstallPreview(source, ref, files), /description/);
});
