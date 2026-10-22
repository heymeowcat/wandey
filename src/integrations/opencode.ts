import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { ProviderConfig } from "../core/config.ts";
import { templateFor } from "../providers/catalog.ts";

/**
 * Reuse the providers OpenCode already set up on this machine.
 *
 * OpenCode stores credentials in a local SQLite database. Wandey opens it
 * read-only, takes API-key credentials (never OAuth refresh tokens), and
 * registers them as normal providers. Nothing is copied to disk or sent
 * anywhere; the secrets only live in the registry's memory.
 *
 * Users can opt out with `{"integrations":{"opencode":false}}` in config.
 */
export interface OpenCodeCredential {
  integrationID: string;
  label: string;
  key: string;
}

/** Integration ids OpenCode uses that differ from our provider ids. */
const ID_MAP: Record<string, string> = {
  google: "gemini",
  "google-generative-ai": "gemini",
  gemini: "gemini",
  openrouter: "openrouter",
  opencode: "opencode",
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral",
  xai: "xai",
  zai: "zai",
  moonshot: "moonshot",
  minimax: "minimax",
  together: "together",
  fireworks: "fireworks",
  cerebras: "cerebras",
};

export function openCodeDBPaths(): string[] {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const candidates = [
    dataHome ? path.join(dataHome, "opencode", "opencode.db") : "",
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    path.join(home, "Library", "Application Support", "opencode", "opencode.db"),
    localAppData ? path.join(localAppData, "opencode", "opencode.db") : "",
    path.join(home, ".opencode", "opencode.db"),
  ];
  return candidates.filter(Boolean);
}

export function openCodeAuthPaths(): string[] {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  const candidates = [
    dataHome ? path.join(dataHome, "opencode", "auth.json") : "",
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(home, "Library", "Application Support", "opencode", "auth.json"),
  ];
  return candidates.filter(Boolean);
}

/** Read credentials without ever throwing into the startup path. */
export function readOpenCodeCredentials(): OpenCodeCredential[] {
  const fromDB = readFromDB();
  if (fromDB.length > 0) return fromDB;
  return readFromAuthJSON();
}

function readFromDB(): OpenCodeCredential[] {
  for (const file of openCodeDBPaths()) {
    if (!fs.existsSync(file)) continue;
    let db: Database | null = null;
    try {
      db = new Database(file, { readonly: true });
      const rows = db
        .query("select integration_id, label, value, active from credential")
        .all() as Array<{ integration_id: string | null; label: string; value: string; active: number | null }>;
      const credentials: OpenCodeCredential[] = [];
      for (const row of rows) {
        if (row.active === 0) continue;
        const parsed = parseValue(row.value);
        if (!parsed) continue;
        credentials.push({
          integrationID: row.integration_id || row.label?.toLowerCase() || "unknown",
          label: row.label || row.integration_id || "OpenCode provider",
          key: parsed,
        });
      }
      return credentials;
    } catch {
      // Database may be locked, migrated, or from an incompatible version.
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }
  return [];
}

function readFromAuthJSON(): OpenCodeCredential[] {
  for (const file of openCodeAuthPaths()) {
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const credentials: OpenCodeCredential[] = [];
      for (const [integrationID, raw] of Object.entries(json)) {
        const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        if (typeof row.key === "string" && row.key.trim() && (row.type === "api" || row.type === "key" || !row.type)) {
          credentials.push({ integrationID, label: integrationID, key: row.key.trim() });
        }
      }
      return credentials;
    } catch {
      // try next path
    }
  }
  return [];
}

function parseValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    // Only API-key style credentials. OAuth tokens need provider-specific
    // flows and refresh handling that wandey deliberately does not own.
    if (row.type && row.type !== "api" && row.type !== "key") return null;
    const key = typeof row.key === "string" ? row.key : typeof row.apiKey === "string" ? row.apiKey : "";
    return key.trim() || null;
  } catch {
    return null;
  }
}

/** Convert OpenCode credentials into provider configs. */
export function openCodeProviderConfigs(
  credentials: OpenCodeCredential[] = readOpenCodeCredentials(),
): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const credential of credentials) {
    const providerID = ID_MAP[credential.integrationID] ?? credential.integrationID;
    const template = templateFor(providerID);
    if (!template) continue;
    providers[providerID] = {
      kind: template.kind,
      baseUrl: template.baseUrl,
      name: template.name,
      apiKey: credential.key,
      description: template.description,
      auto: "opencode",
    };
  }
  return providers;
}
