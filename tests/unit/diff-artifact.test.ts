import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactScopeHash,
  diffArtifactsRoot,
  gcDiffArtifacts,
  writeDiffArtifact,
} from "../../src/diff-artifact.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeCache(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-cache-"));
  tmpDirs.push(d);
  return d;
}

function makeOutside(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgm-outside-"));
  tmpDirs.push(d);
  return d;
}

const uuid = () => crypto.randomUUID();

describe("writeDiffArtifact", () => {
  it("writes the redacted diff under <cacheDir>/diffs and returns its path", async () => {
    const cache = makeCache();
    const body = "diff --git a/a.ts b/a.ts\n+hello\n";
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope: "session-abc",
      artifactId: uuid(),
      redactedDiff: body,
    });

    const realRoot = fs.realpathSync(diffArtifactsRoot(cache));
    expect(p.startsWith(realRoot + path.sep)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(body);
  });

  it("keeps the artifact path strictly inside the managed cache root", async () => {
    const cache = makeCache();
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope: "scope",
      artifactId: uuid(),
      redactedDiff: "x\n",
    });
    const realCache = fs.realpathSync(cache);
    expect(p.startsWith(realCache + path.sep)).toBe(true);
    expect(path.relative(realCache, p).startsWith("..")).toBe(false);
  });

  it("groups artifacts by a hashed scope directory (no raw session id in the path)", async () => {
    const cache = makeCache();
    const scope = "../../etc/evil-session";
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope,
      artifactId: uuid(),
      redactedDiff: "x\n",
    });
    expect(path.basename(path.dirname(p))).toBe(artifactScopeHash(scope));
    expect(p).not.toContain("evil-session");
    expect(p).not.toContain("..");
  });

  it("rejects a non-UUID artifact id (no path traversal via the file name)", async () => {
    const cache = makeCache();
    await expect(
      writeDiffArtifact({
        cacheDir: cache,
        scope: "s",
        artifactId: "../../../../tmp/evil",
        redactedDiff: "x\n",
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_INVALID_ARGS" });
  });

  it("refuses to write through a symlinked scope directory pointing outside the cache root", async () => {
    const cache = makeCache();
    const outside = makeOutside();
    const scope = "escape-me";
    const root = diffArtifactsRoot(cache);
    fs.mkdirSync(root, { recursive: true });
    // Plant the scope directory as a symlink out of the cache root.
    fs.symlinkSync(outside, path.join(root, artifactScopeHash(scope)));

    await expect(
      writeDiffArtifact({
        cacheDir: cache,
        scope,
        artifactId: uuid(),
        redactedDiff: "secret payload\n",
      }),
    ).rejects.toMatchObject({ code: "GROK_MCP_PATH_TRAVERSAL" });

    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not follow a pre-planted symlink at the target file path", async () => {
    const cache = makeCache();
    const outside = makeOutside();
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "original\n");

    const scope = "s";
    const id = uuid();
    const dir = path.join(diffArtifactsRoot(cache), artifactScopeHash(scope));
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(victim, path.join(dir, `${id}.diff`));

    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope,
      artifactId: id,
      redactedDiff: "new content\n",
    });

    // rename() replaced the symlink itself; the victim file is untouched.
    expect(fs.readFileSync(victim, "utf8")).toBe("original\n");
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("new content\n");
  });

  it("creates the artifact with 0600 on unix", async () => {
    if (process.platform === "win32") return;
    const cache = makeCache();
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope: "s",
      artifactId: uuid(),
      redactedDiff: "x\n",
    });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind", async () => {
    const cache = makeCache();
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope: "s",
      artifactId: uuid(),
      redactedDiff: "x\n",
    });
    expect(fs.readdirSync(path.dirname(p))).toHaveLength(1);
  });

  it("concurrent writes in the same scope never collide", async () => {
    const cache = makeCache();
    const N = 24;
    const paths = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeDiffArtifact({
          cacheDir: cache,
          scope: "shared-session",
          artifactId: uuid(),
          redactedDiff: `diff ${i}\n`,
        }),
      ),
    );
    expect(new Set(paths).size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(fs.readFileSync(paths[i]!, "utf8")).toBe(`diff ${i}\n`);
    }
    expect(fs.readdirSync(path.dirname(paths[0]!))).toHaveLength(N);
  });

  it("fails (rather than silently writing elsewhere) when the cache root is unusable", async () => {
    const outside = makeOutside();
    const notADir = path.join(outside, "cache-file");
    fs.writeFileSync(notADir, "not a directory\n");
    await expect(
      writeDiffArtifact({
        cacheDir: notADir,
        scope: "s",
        artifactId: uuid(),
        redactedDiff: "x\n",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("gcDiffArtifacts", () => {
  const OLD = Date.now() - 100 * 3600_000;

  async function agedArtifact(cache: string, scope: string): Promise<string> {
    const p = await writeDiffArtifact({
      cacheDir: cache,
      scope,
      artifactId: uuid(),
      redactedDiff: "old diff\n",
    });
    await fsp.utimes(p, new Date(OLD), new Date(OLD));
    return p;
  }

  it("removes only managed artifacts older than the TTL", async () => {
    const cache = makeCache();
    const stale = await agedArtifact(cache, "s1");
    const fresh = await writeDiffArtifact({
      cacheDir: cache,
      scope: "s2",
      artifactId: uuid(),
      redactedDiff: "fresh\n",
    });

    const removed = await gcDiffArtifacts(cache, 72);

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("leaves unmanaged file names inside the artifacts root untouched", async () => {
    const cache = makeCache();
    const stale = await agedArtifact(cache, "s1");
    const scopeDir = path.dirname(stale);
    const unmanaged = path.join(scopeDir, "notes.txt");
    fs.writeFileSync(unmanaged, "keep me\n");
    fs.utimesSync(unmanaged, new Date(OLD), new Date(OLD));

    await gcDiffArtifacts(cache, 72);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(unmanaged, "utf8")).toBe("keep me\n");
  });

  it("skips directories that are not scope digests", async () => {
    const cache = makeCache();
    const root = diffArtifactsRoot(cache);
    fs.mkdirSync(root, { recursive: true });
    const bogus = path.join(root, "not-a-digest");
    fs.mkdirSync(bogus);
    const file = path.join(bogus, `${uuid()}.diff`);
    fs.writeFileSync(file, "keep\n");
    fs.utimesSync(file, new Date(OLD), new Date(OLD));

    expect(await gcDiffArtifacts(cache, 72)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("never deletes files outside the cache root reached through a symlinked scope dir", async () => {
    const cache = makeCache();
    const outside = makeOutside();
    const victim = path.join(outside, `${uuid()}.diff`);
    fs.writeFileSync(victim, "outside artifact\n");
    fs.utimesSync(victim, new Date(OLD), new Date(OLD));

    const root = diffArtifactsRoot(cache);
    fs.mkdirSync(root, { recursive: true });
    // Symlinked directory whose name *does* look managed.
    fs.symlinkSync(outside, path.join(root, artifactScopeHash("linked")));

    const removed = await gcDiffArtifacts(cache, 72);

    expect(removed).toBe(0);
    expect(fs.readFileSync(victim, "utf8")).toBe("outside artifact\n");
  });

  it("never deletes a symlink target inside a managed scope dir", async () => {
    const cache = makeCache();
    const outside = makeOutside();
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "keep\n");

    const stale = await agedArtifact(cache, "s1");
    const scopeDir = path.dirname(stale);
    const link = path.join(scopeDir, `${uuid()}.diff`);
    fs.symlinkSync(victim, link);
    fs.lutimesSync(link, new Date(OLD), new Date(OLD));

    await gcDiffArtifacts(cache, 72);

    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep\n");
    // The symlink itself is not a regular file, so it is skipped too.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("is a no-op when no artifacts root exists", async () => {
    const cache = makeCache();
    expect(await gcDiffArtifacts(cache, 72)).toBe(0);
    expect(await gcDiffArtifacts(path.join(cache, "nope"), 72)).toBe(0);
  });

  it("prunes an emptied scope directory but keeps the artifacts root", async () => {
    const cache = makeCache();
    const stale = await agedArtifact(cache, "s1");
    await gcDiffArtifacts(cache, 72);
    expect(fs.existsSync(path.dirname(stale))).toBe(false);
    expect(fs.existsSync(diffArtifactsRoot(cache))).toBe(true);
  });
});
