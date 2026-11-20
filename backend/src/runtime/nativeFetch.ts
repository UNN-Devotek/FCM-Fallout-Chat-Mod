import { runtime } from '../runtime';

/** Finish an unused response without buffering an untrusted refusal body.
 * Cancellation belongs to the admitted caller and is awaited through the
 * native stream's terminal notification; SDK initiation isolation does not
 * cover this operation or its application callbacks. */
export async function discardRuntimeResponse(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

/** Node's buffered-body fetch initiation clones the request with a byte-stream
 * tee. Its unused SDK branch can retain a closed-promise after HTTP completion.
 * Prepare application values here, then isolate only that SDK initiation. The
 * caller must still await the response and consume its body inside its owner,
 * including rejected responses. GET and application stream bodies stay scoped.
 */
export function beginRuntimeFetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
  const prepared = { ...init };
  const body = prepared.body;
  if ((typeof input !== 'string' && !(input instanceof URL))
    || (typeof body !== 'string' && !(body instanceof URLSearchParams))) return globalThis.fetch(input, init);

  const headers = prepared.headers;
  if (headers instanceof Headers) prepared.headers = new Headers(headers);
  else if (Array.isArray(headers)) prepared.headers = headers.map(([key, value]) => [String(key), String(value)] as [string, string]);
  else if (headers) prepared.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
  if (body instanceof URLSearchParams) prepared.body = new URLSearchParams(String(body));
  const request = typeof input === 'string' ? input : String(input);
  return runtime.initializeSdkLifetime(() => globalThis.fetch(request, prepared));
}
