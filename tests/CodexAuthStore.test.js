import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import CodexAuthStore from "../src/CodexAuthStore.js";

test("CodexAuthStore reports configured status for a valid auth file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-"));
    const authFile = path.join(tempDir, "auth.json");
    const expirySeconds = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = buildJwt({ exp: expirySeconds });

    await fs.writeFile(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
            access_token: accessToken,
            refresh_token: "refresh-token",
        },
    }), "utf8");

    const store = new CodexAuthStore({ authFile });
    const status = await store.getStatus();

    assert.equal(status.configured, true);
    assert.equal(status.authFile, authFile);
    assert.equal(status.expiresAt, expirySeconds * 1000);
    assert.ok(status.expiresInMs > 0);
});

test("CodexAuthStore reports a helpful error for a missing auth file", async () => {
    const authFile = path.join(os.tmpdir(), "missing-codex-auth.json");
    const store = new CodexAuthStore({ authFile });
    const status = await store.getStatus();

    assert.equal(status.configured, false);
    assert.equal(status.authFile, authFile);
    assert.match(status.error, /Codex auth file not found/);
});

function buildJwt(payload) {
    const header = base64UrlEncode({ alg: "none", typ: "JWT" });
    const body = base64UrlEncode(payload);
    return `${header}.${body}.signature`;
}

function base64UrlEncode(value) {
    return Buffer.from(JSON.stringify(value))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
