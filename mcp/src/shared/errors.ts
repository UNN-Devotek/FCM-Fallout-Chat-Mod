export class McpError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export function mapHttpError(status: number, body: unknown): McpError {
  const message =
    body != null && typeof body === "object" && "detail" in body
      ? String((body as Record<string, unknown>).detail)
      : body != null && typeof body === "object" && "message" in body
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${status}`;

  switch (status) {
    case 400:
      return new McpError(message, -32600);
    case 401:
    case 403:
      return new McpError(message, -32600);
    case 404:
      return new McpError(message, -32601);
    case 422:
      return new McpError(message, -32602);
    default:
      return new McpError(message, -32603);
  }
}
