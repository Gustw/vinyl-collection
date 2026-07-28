import { AppConfig } from './config.service';

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob((b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function contentsUrl(cfg: AppConfig): string {
  return (
    `https://api.github.com/repos/${cfg.githubOwner}/${cfg.githubRepo}` +
    `/contents/${cfg.tracksPath.split('/').map(encodeURIComponent).join('/')}`
  );
}

export interface GithubFile {
  text: string;
  sha: string;
}

export function githubConfigured(cfg: AppConfig): boolean {
  return !!(cfg.githubOwner && cfg.githubRepo && cfg.tracksPath);
}

/** Reads tracks.txt from the repo. Returns null if it doesn't exist yet. */
export async function getTracksFile(cfg: AppConfig): Promise<GithubFile | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (cfg.githubToken) headers['Authorization'] = 'Bearer ' + cfg.githubToken;
  const res = await fetch(contentsUrl(cfg) + '?ref=' + encodeURIComponent(cfg.githubBranch), {
    headers,
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('GitHub read HTTP ' + res.status);
  const data = await res.json();
  return { text: base64ToUtf8(data.content || ''), sha: String(data.sha || '') };
}

/**
 * Writes tracks.txt to the repo. Pass the current `sha` (from a prior read/write)
 * to update; omit it to create. Returns the new blob sha.
 */
export async function putTracksFile(
  cfg: AppConfig,
  text: string,
  sha: string | undefined,
  message: string
): Promise<string> {
  if (!cfg.githubToken) throw new Error('A GitHub token is required to save changes.');
  const body: Record<string, unknown> = {
    message,
    content: utf8ToBase64(text),
    branch: cfg.githubBranch,
  };
  if (sha) body['sha'] = sha;
  const res = await fetch(contentsUrl(cfg), {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + cfg.githubToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('GitHub write HTTP ' + res.status);
  }
  const data = await res.json();
  return String(data?.content?.sha || '');
}

/** Public raw URL for the committed file (CORS-enabled, latest branch content). */
export function rawUrl(cfg: AppConfig): string {
  return (
    `https://raw.githubusercontent.com/${cfg.githubOwner}/${cfg.githubRepo}` +
    `/${cfg.githubBranch}/${cfg.tracksPath}`
  );
}

