/** Poll `fn` every 20 ms until it returns truthy or `timeoutMs` passes. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 3000,
  label = "condition",
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await Bun.sleep(20);
  }
}

export const sleep = (ms: number) => Bun.sleep(ms);
