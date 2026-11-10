#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone check of a packaged macOS app.
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { FORK_IDENTITY } from "@t3tools/shared/remote";

export function checkPolarisApp(app: string) {
  const plist = JSON.parse(
    NodeChildProcess.execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", NodePath.join(app, "Contents/Info.plist")],
      { encoding: "utf8" },
    ),
  );
  NodeAssert.equal(plist.CFBundleIdentifier, FORK_IDENTITY.appId);
  NodeAssert.equal(plist.CFBundleName, FORK_IDENTITY.productName);
  NodeAssert.ok(
    plist.CFBundleURLTypes.some((entry: { CFBundleURLSchemes?: string[] }) =>
      entry.CFBundleURLSchemes?.includes(FORK_IDENTITY.scheme),
    ),
  );
}
if (import.meta.main) {
  const app = process.argv[2];
  NodeAssert.ok(app, "Usage: node scripts/check-polaris-app.ts <Polaris.app>");
  checkPolarisApp(app);
  console.log("Packaged Polaris identity and URL scheme verified.");
}
