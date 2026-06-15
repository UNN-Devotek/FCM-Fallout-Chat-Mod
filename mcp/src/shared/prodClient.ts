/**
 * HTTP client for the prod MCP admin API.
 * Base URL is HARDCODED to https://falloutchatmod.com — this is intentional;
 * the prod MCP server must always hit the production backend.
 */
import { mapHttpError } from "./errors.js";

const BASE_URL = "https://falloutchatmod.com";

function getToken(): string {
  const token = process.env["FCM_MCP_TOKEN"];
  if (!token) {
    throw new Error("FCM_MCP_TOKEN environment variable is not set");
  }
  return token;
}

async function handleResponse(res: Response): Promise<unknown> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw mapHttpError(res.status, body);
  }
  const json = (await res.json()) as { data: unknown };
  return json.data;
}

export async function fcmAdminGet(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
  });
  return handleResponse(res);
}

export async function fcmAdminPost(path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res);
}

export async function fcmAdminPatch(path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res);
}

export async function fcmAdminDelete(path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, BASE_URL);
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handleResponse(res);
}
