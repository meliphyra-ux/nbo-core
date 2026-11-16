// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// What every nbo-server command shares: reading secrets, calling the control-plane and printing answers.
import { Failed, UsageError, isRecord, need, str, type ServerCliIO, type Values } from "./args.js";

export function createCliContext(io: ServerCliIO) {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let stdinUsed = false;

  // readSecret: a file's text, or stdin for "-" (at most once per command).
  const readSecret = async (path: string, flag: string): Promise<string> => {
    if (path === "-") {
      if (stdinUsed) throw new UsageError(`only one flag can read stdin ("-"); give --${flag} a file`);
      stdinUsed = true;
      return io.stdin();
    }
    try {
      return await io.readFile(path);
    } catch (err) {
      throw new UsageError(`--${flag}: can't read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const readJsonFile = async (path: string, flag: string): Promise<unknown> => {
    const text = await readSecret(path, flag);
    try {
      return JSON.parse(text);
    } catch {
      // The text may be secret: say where it came from, not what it was.
      throw new UsageError(`--${flag}: ${path === "-" ? "stdin" : path} is not JSON`);
    }
  };

  let base = "";

  // call: one request; the parsed answer, or Failed with the status and error.
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    // The control-plane never redirects; following one could resend a secret body elsewhere.
    const init: RequestInit = { method, redirect: "error" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    let res: Response;
    try {
      res = await io.fetch(base + path, init);
    } catch (err) {
      throw new Failed(
        `can't reach the control-plane at ${base}: ${err instanceof Error ? err.message : String(err)}. Is NBO running? Set NBO_SERVER_URL if it listens on another port of this computer.`,
      );
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const msg =
        isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed === "string" && parsed !== ""
            ? parsed
            : res.statusText;
      throw new Failed(`${res.status} ${msg}`);
    }
    return parsed;
  };

  const print = (value: unknown): void => {
    if (value === undefined) io.out("done");
    else io.out(JSON.stringify(value, null, 2));
  };

  const kubeconfigSource = async (v: Values, flag: string): Promise<Record<string, unknown>> => {
    const kubeconfig = await readSecret(need(v, flag), flag);
    const source: Record<string, unknown> = { kind: "kubeconfig", kubeconfig };
    const context = str(v, "context");
    if (context) source.context = context;
    return source;
  };

  const confirmBilling = (v: Values, what: string): void => {
    if (v["confirm-billing"] !== true) {
      throw new UsageError(
        `${what} makes a load balancer that your cloud provider bills for. Add --confirm-billing to go ahead.`,
      );
    }
  };

  // requestBody: JSON from --body-file or --body-stdin, or none.
  async function requestBody(values: Values): Promise<unknown> {
    const file = str(values, "body-file");
    if (file !== undefined && values["body-stdin"] === true)
      throw new UsageError("use --body-file or --body-stdin, not both");
    if (file !== undefined) return readJsonFile(file, "body-file");
    if (values["body-stdin"] === true) return readJsonFile("-", "body-stdin");
    return undefined;
  }

  const setBase = (url: string): void => {
    base = url;
  };

  return { io, sleep, readSecret, readJsonFile, call, print, kubeconfigSource, confirmBilling, requestBody, setBase };
}

export type CliContext = ReturnType<typeof createCliContext>;
