import { describe, expect, it, vi } from 'vitest';
import { createLatestRequest } from '../../apps/web/src/lib/latest-request.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe('workspace refresh coordination', () => {
  function setup() {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const signals: AbortSignal[] = [];
    const callbacks = {
      request: vi.fn((signal: AbortSignal) => { const work = deferred<string>(); pending.push(work); signals.push(signal); return work.promise; }),
      onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn(),
    };
    return { loader: createLatestRequest(callbacks), callbacks, pending, signals };
  }

  it('shares slow polling, online and manual refreshes without discarding the first result', async () => {
    const { loader, callbacks, pending } = setup();
    const initial = loader.run();
    await Promise.resolve();
    expect(loader.run()).toBe(initial);
    expect(loader.run()).toBe(initial);
    expect(callbacks.request).toHaveBeenCalledTimes(1);
    pending[0]!.resolve('workspace');
    await expect(initial).resolves.toBe('workspace');
    expect(callbacks.onSuccess).toHaveBeenCalledExactlyOnceWith('workspace');
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
  });

  it('replaces pre-mutation requests and ignores a stale response that finishes last', async () => {
    const { loader, callbacks, pending, signals } = setup();
    const old = loader.run();
    await Promise.resolve();
    const fresh = loader.run({ replace: true });
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
    pending[1]!.resolve('updated workspace');
    await fresh;
    pending[0]!.resolve('stale workspace');
    await expect(old).resolves.toBeNull();
    expect(callbacks.onSuccess).toHaveBeenCalledExactlyOnceWith('updated workspace');
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not clear the new loading state when an abandoned request fails', async () => {
    const { loader, callbacks, pending } = setup();
    const old = loader.run();
    await Promise.resolve();
    const fresh = loader.run({ replace: true });
    await Promise.resolve();
    pending[0]!.reject(new Error('old request failed'));
    await old;
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onSettled).not.toHaveBeenCalled();
    pending[1]!.resolve('current');
    await fresh;
    expect(callbacks.onSuccess).toHaveBeenCalledExactlyOnceWith('current');
  });

  it('cancels on unmount or sign-out without publishing later patient data', async () => {
    const { loader, callbacks, pending, signals } = setup();
    const result = loader.run();
    await Promise.resolve();
    loader.cancel();
    expect(signals[0]?.aborted).toBe(true);
    pending[0]!.resolve('abandoned patient data');
    await expect(result).resolves.toBeNull();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onSettled).not.toHaveBeenCalled();
  });

  it('survives the setup-cleanup-setup sequence used by Strict Mode', async () => {
    const { loader, callbacks, pending } = setup();
    const abandoned = loader.run();
    loader.cancel();
    const current = loader.run();
    await Promise.resolve();
    expect(callbacks.request).toHaveBeenCalledTimes(1);
    pending[0]!.resolve('ready');
    await Promise.all([abandoned, current]);
    expect(callbacks.onSuccess).toHaveBeenCalledExactlyOnceWith('ready');
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
  });

  it('exits loading on failure and starts a new request when the user retries', async () => {
    const { loader, callbacks, pending } = setup();
    const failed = loader.run();
    await Promise.resolve();
    const error = new Error('Loading timed out');
    pending[0]!.reject(error);
    await expect(failed).resolves.toBeNull();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
    const retried = loader.run();
    await Promise.resolve();
    pending[1]!.resolve('recovered');
    await expect(retried).resolves.toBe('recovered');
    expect(callbacks.onSuccess).toHaveBeenCalledExactlyOnceWith('recovered');
    expect(callbacks.onSettled).toHaveBeenCalledTimes(2);
  });
});
