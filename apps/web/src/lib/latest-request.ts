type RequestCallbacks<T> = {
  request: (signal: AbortSignal) => Promise<T>;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
};

/** Share refreshes, but replace pre-mutation work and ignore abandoned results. */
export function createLatestRequest<T>(callbacks: RequestCallbacks<T>) {
  type Pending = { controller: AbortController; promise: Promise<T | null> };
  let active: Pending | null = null;
  const cancel = () => {
    const previous = active;
    active = null;
    previous?.controller.abort();
  };
  const run = (options: { replace?: boolean } = {}): Promise<T | null> => {
    if (active && !options.replace) return active.promise;
    cancel();
    const current: Pending = { controller: new AbortController(), promise: Promise.resolve(null) };
    active = current;
    current.promise = Promise.resolve().then(async () => {
      try {
        current.controller.signal.throwIfAborted();
        const value = await callbacks.request(current.controller.signal);
        if (active !== current || current.controller.signal.aborted) return null;
        callbacks.onSuccess(value);
        return value;
      } catch (error) {
        if (active === current && !current.controller.signal.aborted) callbacks.onError(error);
        return null;
      } finally {
        if (active === current) {
          active = null;
          callbacks.onSettled();
        }
      }
    });
    return current.promise;
  };
  return { run, cancel };
}
