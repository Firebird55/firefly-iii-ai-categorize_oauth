import fs from "node:fs/promises";
import path from "node:path";
import { refreshOpenAICodexToken } from "@mariozechner/pi-ai/oauth";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function decodeJwtExpiryMs(token) {
    if (typeof token !== "string" || !token.includes(".")) {
        return null;
    }

    try {
        const [, payload] = token.split(".", 3);
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
        const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
    } catch {
        return null;
    }
}

export default class CodexAuthStore {
    #authFile;

    constructor({ authFile }) {
        this.#authFile = authFile;
    }

    async getStatus() {
        try {
            const state = await this.#load();
            const accessToken = state?.tokens?.access_token?.trim();
            const refreshToken = state?.tokens?.refresh_token?.trim();
            const expiresAt = decodeJwtExpiryMs(accessToken);

            return {
                configured: Boolean(accessToken && refreshToken),
                authFile: this.#authFile,
                expiresAt,
                expiresInMs: expiresAt === null ? null : expiresAt - Date.now(),
            };
        } catch (error) {
            return {
                configured: false,
                authFile: this.#authFile,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async getAccessToken() {
        const state = await this.#load();
        const accessToken = state?.tokens?.access_token?.trim();
        if (!accessToken) {
            throw new Error(
                `Missing Codex access token in ${this.#authFile}. Provide a Codex auth.json file first.`,
            );
        }

        const refreshToken = state?.tokens?.refresh_token?.trim();
        if (refreshToken && this.#isExpiringSoon(accessToken)) {
            try {
                const refreshed = await this.#refresh(state);
                return refreshed.tokens.access_token;
            } catch (error) {
                if (!this.#isExpired(accessToken)) {
                    console.warn(
                        "Codex token refresh failed but the cached token is still valid. Continuing with cached token.",
                        error,
                    );
                    return accessToken;
                }
                throw error;
            }
        }

        return accessToken;
    }

    #isExpiringSoon(accessToken) {
        const expiresAt = decodeJwtExpiryMs(accessToken);
        return expiresAt !== null && expiresAt <= Date.now() + REFRESH_MARGIN_MS;
    }

    #isExpired(accessToken) {
        const expiresAt = decodeJwtExpiryMs(accessToken);
        return expiresAt !== null && expiresAt <= Date.now();
    }

    async #refresh(state) {
        const refreshToken = state?.tokens?.refresh_token?.trim();
        if (!refreshToken) {
            throw new Error(`Missing Codex refresh token in ${this.#authFile}.`);
        }

        const refreshed = await refreshOpenAICodexToken(refreshToken);
        const nextState = {
            auth_mode: state?.auth_mode ?? "chatgpt",
            OPENAI_API_KEY: null,
            tokens: {
                ...(state?.tokens ?? {}),
                ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
                access_token: refreshed.access,
                refresh_token: refreshed.refresh ?? refreshToken,
                ...(refreshed.accountId ? { account_id: refreshed.accountId } : {}),
            },
            last_refresh: new Date().toISOString(),
        };

        await this.#write(nextState);
        return nextState;
    }

    async #load() {
        let raw;
        try {
            raw = await fs.readFile(this.#authFile, "utf8");
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                throw new Error(
                    `Codex auth file not found at ${this.#authFile}. Mount or copy a valid auth.json file first.`,
                );
            }
            throw error;
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`Codex auth file at ${this.#authFile} is not valid JSON: ${error}`);
        }

        if (!parsed || typeof parsed !== "object" || !parsed.tokens || typeof parsed.tokens !== "object") {
            throw new Error(`Codex auth file at ${this.#authFile} does not contain a tokens block.`);
        }

        return parsed;
    }

    async #write(value) {
        await fs.mkdir(path.dirname(this.#authFile), { recursive: true });
        await fs.writeFile(this.#authFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
}
