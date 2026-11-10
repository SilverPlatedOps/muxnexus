// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { networkInterfaces } from "node:os";

/**
 * Focus from outside: a program on this Mac (the desk board's feeder) asks the pages
 * open here to show an agent's window, as a click in the sidebar would.
 */

type Interfaces = Record<string, { address: string }[] | undefined>;

/**
 * Whether an address is this machine: loopback, or one of its own interfaces -- its
 * Tailscale address included, which is how the page on this Mac usually connects. A
 * phone or tablet on the tailnet is another address, so its page is left alone.
 */
export function isThisMachine(address: string | null | undefined, interfaces: Interfaces = networkInterfaces()): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  return Object.values(interfaces).some((list) => list?.some((i) => i.address === a));
}

/** The body of POST /api/focus: `{ "pane": "%140" }`. */
export function parseFocusRequest(body: unknown): { pane: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const pane = (body as { pane?: unknown }).pane;
  return typeof pane === "string" && /^%\d+$/.test(pane) ? { pane } : null;
}
