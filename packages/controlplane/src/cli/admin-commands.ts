// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-server commands for the operator: API tokens, the link to a platform, unlinking and member keys.
import { Failed, UsageError, isRecord, need, parse, segment, str } from "./args.js";
import type { CliContext } from "./context.js";
import { isKeyFingerprint } from "../link/enroll.js";

const GOOGLE_CLEAN = "Google trusts only this core's key, and nothing else can act as nbo-deployer.";

const KEYS_RESET_USAGE =
  "keys reset needs the key it is for: nbo-server keys reset --key sha256:<fingerprint> (the fingerprint the dashboard shows for the new key)";

export async function runAdminCommand(
  ctx: CliContext,
  cmd: string,
  sub: string | undefined,
  rest: string[],
  after: string[],
): Promise<number | undefined> {
  const { io, readSecret, call, print } = ctx;
  switch (cmd) {
    case "token": {
      if (sub === "create") {
        const { pos } = parse(rest, {}, 1);
        const answer = await call("POST", "/system/api-tokens", { name: pos[0] });
        const { token, ...view } = isRecord(answer) ? answer : { token: undefined };
        print(view);
        if (typeof token === "string") {
          io.out("");
          io.out(`Token (store it now, it is not shown again): ${token}`);
        }
        return 0;
      }
      if (sub === "list") {
        parse(rest, {}, 0);
        print(await call("GET", "/system/api-tokens"));
        return 0;
      }
      if (sub === "revoke") {
        const { pos } = parse(rest, {}, 1);
        print(await call("DELETE", `/system/api-tokens/${segment(pos[0]!, "token id")}`));
        return 0;
      }
      throw new UsageError("token needs create <name>, list or revoke <id>");
    }

    case "link": {
      if (sub === "status") {
        parse(rest, {}, 0);
        print(await call("GET", "/link/status"));
        return 0;
      }
      if (sub === "journal") {
        const { values } = parse(rest, { limit: { type: "string" } }, 0);
        const limit = str(values, "limit");
        if (limit !== undefined && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 500))
          throw new UsageError("--limit must be a whole number from 1 to 500");
        print(await call("GET", `/link/journal${limit === undefined ? "" : `?limit=${limit}`}`));
        return 0;
      }
      // link <code|->: the code is the one argument; "-" reads it from stdin.
      // It goes in the request body only and is never printed.
      const { values, pos } = parse(after, { url: { type: "string" }, "owner-key": { type: "string" } }, 1);
      const url = need(values, "url");
      const ownerKeyFingerprint = need(values, "owner-key");
      const code = pos[0] === "-" ? (await readSecret("-", "code")).trim() : pos[0]!;
      if (code === "") throw new UsageError("the enrollment code is empty");
      const answer = await call("POST", "/system/link/enroll", { url, code, ownerKeyFingerprint });
      print(answer);
      io.out("Linked. The link connects in the background; check it with: nbo-server link status");
      return 0;
    }

    case "google": {
      if (sub === "check") {
        // The core's own self-check of its keyless connection, run as the
        // deployer straight against Google: the step that proves the setup
        // command did only what it said.
        parse(rest, {}, 0);
        const answer = await call("POST", "/system/connections/google/test", {});
        const conn = isRecord(answer) ? answer : {};
        if (conn.auth !== "wif") {
          io.out("This core's Google connection uses a key, not keyless: there is no keyless check to run.");
          return 1;
        }
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
        const warnings = list(conn.checkWarnings);
        const others = list(conn.otherCores);
        if (warnings.length === 0 && others.length === 0) {
          io.out(GOOGLE_CLEAN);
          return 0;
        }
        for (const w of warnings) io.out(w);
        for (const o of others) io.out(`Other core this project trusts: ${o}`);
        return warnings.length === 0 ? 0 : 1;
      }
      if (sub !== "identity") throw new UsageError("google needs identity or check");
      parse(rest, {}, 0);
      const answer = await call("GET", "/system/connections/google/identity");
      const { issuer, subject, provider, keyId } = isRecord(answer) ? answer : ({} as Record<string, unknown>);
      print({ issuer, subject, provider, keyId });
      return 0;
    }

    case "unlink": {
      parse(after, {}, 0);
      await call("POST", "/system/link/unlink", {});
      io.out(
        "Unlinked: this server dropped the platform's keys and the member keys and closed the link; the journal is kept.",
      );
      return 0;
    }

    case "keys": {
      if (sub === "reset") {
        // --key binds the code to one key: whoever else gets the code can't register theirs.
        const { values } = parse(rest, { key: { type: "string" } }, 0);
        const keyFingerprint = str(values, "key");
        if (!isKeyFingerprint(keyFingerprint)) throw new UsageError(KEYS_RESET_USAGE);
        const answer = await call("POST", "/system/link/keys-reset", { keyFingerprint });
        const code = isRecord(answer) && typeof answer.code === "string" ? answer.code : "";
        const expiresAt = isRecord(answer) && typeof answer.expiresAt === "string" ? answer.expiresAt : "";
        if (code === "")
          throw new Failed("the control-plane's answer has no reset code; run nbo-server keys reset again");
        io.out(`Reset code (works once, until ${expiresAt}; it is not shown again): ${code}`);
        io.out(`It registers only the Owner key ${keyFingerprint}.`);
        io.out(
          "An Owner enters it in the dashboard, in the browser that holds that key. Trying any other key with it uses the code up: run this command again.",
        );
        return 0;
      }
      if (sub === "list") {
        parse(rest, {}, 0);
        print(await call("GET", "/link/member-keys"));
        return 0;
      }
      throw new UsageError("keys needs reset or list");
    }

    default:
      return undefined;
  }
}
