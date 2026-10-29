// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/** Bun's bundler turns an imported picture into the URL it serves it at. */
declare module "*.png" {
  const url: string;
  export default url;
}

/** A prebuilt module, imported as a file: Bun serves it at a URL, loaded only when needed. */
declare module "*/pixi.min.mjs" {
  const url: string;
  export default url;
}
