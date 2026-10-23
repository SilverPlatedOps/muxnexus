import { dlopen, FFIType, ptr, read } from "bun:ffi";

/**
 * A process's memory as Activity Monitor counts it: phys_footprint, which
 * includes what the compressor holds and what has been swapped out -- RSS counts
 * only what is resident, so a process squeezed into the compressor looks small.
 * Read through libproc rather than `top`, which takes a third of a second of
 * kernel time to say the same: one call per process, about 2 ms for 500.
 *
 * Another user's process (root daemons, WindowServer) cannot be read without
 * root and is "denied"; one that exited since the process list was taken is
 * "gone", which is churn and not a gap in the figures.
 */

export type Footprint = { bytes: number } | { error: "gone" | "denied" };

/** `proc_pid_rusage`'s flavor for `struct rusage_info_v2`. */
export const RUSAGE_INFO_V2 = 2;
/** sizeof(struct rusage_info_v2): a 16-byte uuid and eighteen uint64s. */
export const RUSAGE_INFO_V2_SIZE = 160;
/** offsetof(struct rusage_info_v2, ri_phys_footprint): after the uuid and seven uint64s. */
export const PHYS_FOOTPRINT_OFFSET = 72;

const ESRCH = 3;

/** Null when libproc or libSystem cannot be opened, so the caller falls back to RSS. */
export function footprintReader(): ((pid: number) => Footprint) | null {
  let proc: ReturnType<typeof openProc>;
  let sys: ReturnType<typeof openSys>;
  try {
    proc = openProc();
    sys = openSys();
  } catch {
    return null;
  }
  // Kept for the reader's life: the kernel writes into it on every call, so it
  // must not be collected or moved while a call is in flight.
  const buf = new BigUint64Array(RUSAGE_INFO_V2_SIZE / 8);
  const at = ptr(buf);
  return (pid) => {
    if (proc.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, at) !== 0) {
      // errno is read straight after the failing call, on the same thread.
      const errno = read.i32(sys.symbols.__error()!, 0);
      return { error: errno === ESRCH ? "gone" : "denied" };
    }
    return { bytes: Number(buf[PHYS_FOOTPRINT_OFFSET / 8]) };
  };
}

function openProc() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
}

function openSys() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    __error: { args: [], returns: FFIType.ptr },
  });
}
