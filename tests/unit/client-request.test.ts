import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, setSessionTokenGetter } from '../../apps/web/src/lib/api.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('authenticated client request lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    setSessionTokenGetter(async () => 'fixture-token');
  });
  afterEach(() => {
    setSessionTokenGetter(null);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['token', 'fetch', 'body'] as const)('bounds a stalled %s stage, including response-body reads', async stage => {
    const stalled = new Promise<never>(() => {});
    if (stage === 'token') setSessionTokenGetter(() => stalled);
    else if (stage === 'fetch') vi.mocked(fetch).mockReturnValue(stalled);
    else {
      const response = Response.json({});
      vi.spyOn(response, 'json').mockReturnValue(stalled);
      vi.mocked(fetch).mockResolvedValue(response);
    }
    const result = request('/workspace');
    const failure = expect(result).rejects.toMatchObject({ status: 408, code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    if (stage === 'token') expect(fetch).not.toHaveBeenCalled();
    else expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a request when an unabortable token arrives after timeout', async () => {
    const token = deferred<string>();
    setSessionTokenGetter(() => token.promise);
    const result = request('/workspace');
    const failure = expect(result).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    token.resolve('late-fixture-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels token acquisition on unmount and never fetches with its late token', async () => {
    const token = deferred<string>();
    const controller = new AbortController();
    setSessionTokenGetter(() => token.promise);
    const result = request('/identity', { signal: controller.signal });
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await failure;
    token.resolve('late-fixture-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a signal cancelled before the request is started', async () => {
    const tokenGetter = vi.fn(async () => 'fixture-token');
    setSessionTokenGetter(tokenGetter);
    const controller = new AbortController();
    controller.abort();
    await expect(request('/identity', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(tokenGetter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels an in-flight fetch through the caller signal', async () => {
    vi.mocked(fetch).mockReturnValue(new Promise<never>(() => {}));
    const controller = new AbortController();
    const result = request('/workspace', { signal: controller.signal });
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failure;
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('rejects a token from a previous session before starting the network request', async () => {
    const token = deferred<string>();
    setSessionTokenGetter(() => token.promise);
    const result = request('/workspace');
    const failure = expect(result).rejects.toMatchObject({ status: 401, code: 'SESSION_CHANGED' });
    setSessionTokenGetter(async () => 'new-session-fixture');
    token.resolve('old-session-fixture');
    await failure;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an old session response even when its body finishes after account switch', async () => {
    const body = deferred<unknown>();
    const response = Response.json({});
    vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.mocked(fetch).mockResolvedValue(response);
    const result = request('/workspace');
    const failure = expect(result).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.advanceTimersByTimeAsync(0);
    setSessionTokenGetter(null);
    body.resolve({ privateRecord: 'old-session-data' });
    await failure;
  });

  it('keeps valid in-flight requests when identity refresh registers the same session again', async () => {
    const body = deferred<unknown>();
    const response = Response.json({});
    vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.mocked(fetch).mockResolvedValue(response);
    setSessionTokenGetter(async () => 'fixture-token', 'user:session-a');
    const result = request('/workspace');
    await vi.advanceTimersByTimeAsync(0);
    setSessionTokenGetter(async () => 'refreshed-fixture-token', 'user:session-a');
    body.resolve({ ready: true });
    await expect(result).resolves.toEqual({ ready: true });
  });

  it('can recover the current session after failed sign-out without reviving its old requests', async () => {
    const body = deferred<unknown>();
    const response = Response.json({});
    vi.spyOn(response, 'json').mockReturnValue(body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(response);
    setSessionTokenGetter(async () => 'fixture-token', 'user:session-a');
    const abandoned = request('/workspace');
    const failure = expect(abandoned).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.advanceTimersByTimeAsync(0);
    setSessionTokenGetter(null);
    setSessionTokenGetter(async () => 'fixture-token', 'user:session-a');
    body.resolve({ stale: true });
    await failure;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ identity: 'current' }));
    await expect(request('/identity')).resolves.toEqual({ identity: 'current' });
  });

  it('preserves authentication, uncached reads and Headers-based idempotency keys', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ saved: true }));
    await expect(request('/episodes/test/actions', { method: 'POST', headers: new Headers({ 'Idempotency-Key': 'fixture-key' }), body: '{}' })).resolves.toEqual({ saved: true });
    const options = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(options?.credentials).toBe('same-origin');
    expect(options?.cache).toBe('no-store');
    const headers = new Headers(options?.headers);
    expect(headers.get('Authorization')).toBe('Bearer fixture-token');
    expect(headers.get('Idempotency-Key')).toBe('fixture-key');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives mutations a longer deadline and never automatically retries an uncertain write', async () => {
    vi.mocked(fetch).mockReturnValue(new Promise<never>(() => {}));
    const result = request('/episodes/test/actions', { method: 'POST', body: '{}' });
    const failure = expect(result).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('check whether your change was saved') });
    await vi.advanceTimersByTimeAsync(15000);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(45000);
    await failure;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['not json', 'null'])('surfaces malformed successful responses (%s) instead of returning a null loading state', async body => {
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 200 }));
    await expect(request('/identity')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('retains server authentication errors and permits an explicit retry after a timeout', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Session expired.' } }, { status: 401 }));
    await expect(request('/identity')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED', message: 'Session expired.' });
    vi.mocked(fetch).mockReturnValueOnce(new Promise<never>(() => {}));
    const failure = expect(request('/workspace')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ready: true }));
    await expect(request('/workspace')).resolves.toEqual({ ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
