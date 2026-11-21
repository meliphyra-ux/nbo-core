// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-server commands about projects: setup and retry, transfers, revalidation and the raw API.
import { UsageError, fileFlag, isRecord, need, parse, segment } from "./args.js";
import type { CliContext } from "./context.js";

export async function runProjectCommand(
  ctx: CliContext,
  cmd: string,
  sub: string | undefined,
  rest: string[],
  after: string[],
): Promise<number | undefined> {
  const { io, call, print, requestBody } = ctx;
  switch (cmd) {
    case "project": {
      if (sub === "setup") {
        const { values } = parse(rest, { "body-file": fileFlag, "body-stdin": { type: "boolean" } }, 0);
        const body = await requestBody(values);
        if (body === undefined) throw new UsageError("project setup needs --body-file or --body-stdin");
        const summary = await call("POST", "/projects/setup", body);
        print(summary);
        const project = isRecord(summary) && isRecord(summary.project) ? summary.project : undefined;
        const id = typeof project?.id === "string" ? project.id : "";
        const wantsKey = isRecord(body) && isRecord(body.credential) && body.credential.kind === "deploy-key";
        if (wantsKey && id) {
          const git = await call("GET", `/projects/${segment(id, "project id")}/git`);
          const publicKey =
            isRecord(git) && isRecord(git.credential) && typeof git.credential.publicKey === "string"
              ? git.credential.publicKey
              : "";
          io.out("");
          io.out("Deploy key (public half):");
          io.out(publicKey);
          io.out("");
          io.out("Next: add this key to the repository as a read-only deploy key. NBO's first look at the");
          io.out("repository fails until you do. Once it is added, run:");
          io.out(`  nbo-server project retry ${id}`);
        }
        return 0;
      }
      if (sub === "retry") {
        const { pos } = parse(rest, {}, 1);
        print(await call("POST", `/projects/${segment(pos[0]!, "project id")}/setup/retry`, {}));
        return 0;
      }
      throw new UsageError("project needs setup or retry <id>");
    }

    case "transfer": {
      if (sub === "cancel") {
        const { pos } = parse(rest, {}, 1);
        print(await call("POST", `/projects/${segment(pos[0]!, "project id")}/transfer/cancel`));
        return 0;
      }
      const { values, pos } = parse(after, { to: { type: "string" } }, 1);
      const id = segment(pos[0]!, "project id");
      const to = need(values, "to");
      let body: Record<string, unknown>;
      if (to === "cloudrun") body = { target: "cloudrun", mode: "auto" };
      else if (to === "lambda") body = { target: "lambda" };
      else if (to === "kubernetes") body = { target: "kubernetes" };
      else if (/^kc_[a-z0-9]{1,32}$/.test(to)) body = { target: "kubernetes", clusterId: to };
      else throw new UsageError("--to must be cloudrun, lambda, kubernetes or a cluster id (kc_...)");
      print(await call("POST", `/projects/${id}/transfer`, body));
      return 0;
    }

    case "revalidate": {
      const { values, pos } = parse(
        after,
        {
          stage: { type: "string" },
          tag: { type: "string", multiple: true },
          path: { type: "string", multiple: true },
        },
        1,
      );
      const id = segment(pos[0]!, "project id");
      const stage = segment(need(values, "stage"), "stage id");
      const body: Record<string, unknown> = {};
      const tags = values.tag as string[] | undefined;
      const paths = values.path as string[] | undefined;
      if (tags?.length) body.tags = tags;
      if (paths?.length) body.paths = paths;
      if (!body.tags && !body.paths) throw new UsageError("give at least one --tag or --path");
      print(await call("POST", `/projects/${id}/stages/${stage}/revalidate`, body));
      return 0;
    }

    case "api": {
      const { values, pos } = parse(after, { "body-file": fileFlag, "body-stdin": { type: "boolean" } }, 2);
      const method = pos[0]!.toUpperCase();
      const path = pos[1]!;
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method))
        throw new UsageError("METHOD must be GET, POST, PUT, PATCH or DELETE");
      if (!/^\/[^\s]*$/.test(path) || path.startsWith("//"))
        throw new UsageError('the path must start with "/", like /projects');
      print(await call(method, path, await requestBody(values)));
      return 0;
    }

    default:
      return undefined;
  }
}
