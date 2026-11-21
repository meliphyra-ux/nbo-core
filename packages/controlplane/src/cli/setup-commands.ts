// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// nbo-server commands that set NBO up: status, cloud connections, clusters, the edge and domains.
import { Failed, UsageError, fileFlag, isRecord, jobStatus, maxWaitMs, need, parse, pollMs, segment } from "./args.js";
import type { CliContext } from "./context.js";

export async function runSetupCommand(
  ctx: CliContext,
  cmd: string,
  sub: string | undefined,
  rest: string[],
  after: string[],
): Promise<number | undefined> {
  const { io, sleep, readSecret, readJsonFile, call, print, kubeconfigSource, confirmBilling } = ctx;
  switch (cmd) {
    case "status": {
      parse(after, {}, 0);
      const preflight = await call("GET", "/system/preflight");
      const connections = await call("GET", "/system/connections");
      const edge = await call("GET", "/system/edge");
      print({ preflight, connections, edge });
      return 0;
    }

    case "connect": {
      if (sub === "google") {
        const { values } = parse(
          rest,
          {
            "key-file": fileFlag,
            "from-machine": { type: "boolean" },
            code: { type: "string" },
            project: { type: "string" },
            region: { type: "string" },
          },
          0,
        );
        const region = need(values, "region");
        if (values.code !== undefined) {
          // Keyless: the connection code the setup command printed.
          if (values["key-file"] !== undefined || values["from-machine"] !== undefined || values.project !== undefined)
            throw new UsageError("--code goes alone with --region: the code names its own project");
          print(
            await call("POST", "/system/connections/google", { source: "wif", code: need(values, "code"), region }),
          );
          return 0;
        }
        if (values["from-machine"] === true) {
          if (values["key-file"] !== undefined) throw new UsageError("use --key-file or --from-machine, not both");
          print(
            await call("POST", "/system/connections/google", {
              source: "machine",
              project: need(values, "project"),
              region,
            }),
          );
          return 0;
        }
        if (values.project !== undefined)
          throw new UsageError("--project goes with --from-machine; a key file names its own project");
        const keyJson = await readSecret(need(values, "key-file"), "key-file");
        print(await call("POST", "/system/connections/google", { source: "key", keyJson, region }));
        return 0;
      }
      if (sub === "kubernetes") {
        const { values } = parse(
          rest,
          {
            name: { type: "string" },
            "kubeconfig-file": fileFlag,
            context: { type: "string" },
            "registry-file": fileFlag,
          },
          0,
        );
        const name = need(values, "name");
        const registryPath = need(values, "registry-file");
        const source = await kubeconfigSource(values, "kubeconfig-file");
        const reg = await readJsonFile(registryPath, "registry-file");
        if (!isRecord(reg) || !isRecord(reg.registry)) {
          throw new UsageError(
            '--registry-file must hold {"registry": {"kind": "artifact-registry"} or {"kind": "custom", "server": ..., "username": ...}, "registryPassword": ...}',
          );
        }
        const body: Record<string, unknown> = { name, source, registry: reg.registry };
        if (reg.registryPassword !== undefined) body.registryPassword = reg.registryPassword;
        print(await call("POST", "/system/connections/kubernetes", body));
        return 0;
      }
      if (sub === "aws") {
        const { values } = parse(
          rest,
          { "access-key-id": { type: "string" }, "secret-key-file": fileFlag, region: { type: "string" } },
          0,
        );
        const accessKeyId = need(values, "access-key-id");
        const region = need(values, "region");
        const secretAccessKey = (await readSecret(need(values, "secret-key-file"), "secret-key-file")).trim();
        print(await call("POST", "/system/connections/aws", { accessKeyId, secretAccessKey, region }));
        return 0;
      }
      throw new UsageError("connect needs google, kubernetes or aws");
    }

    case "disconnect": {
      if (sub === "google" || sub === "aws") {
        parse(rest, {}, 0);
        print(await call("DELETE", `/system/connections/${sub}`));
        return 0;
      }
      if (sub === "kubernetes") {
        const { pos } = parse(rest, {}, 1);
        print(await call("DELETE", `/system/connections/kubernetes/${segment(pos[0]!, "cluster id")}`));
        return 0;
      }
      throw new UsageError("disconnect needs google, aws or kubernetes <id>");
    }

    case "cluster": {
      if (sub === "test") {
        const { pos } = parse(rest, {}, 1);
        print(await call("POST", `/system/connections/kubernetes/${segment(pos[0]!, "cluster id")}/test`));
        return 0;
      }
      if (sub === "update-setup") {
        const { values, pos } = parse(rest, { "admin-kubeconfig-file": fileFlag, context: { type: "string" } }, 1);
        const id = segment(pos[0]!, "cluster id");
        const admin = await kubeconfigSource(values, "admin-kubeconfig-file");
        print(await call("POST", `/system/clusters/${id}/update-setup`, { admin }));
        return 0;
      }
      if (sub === "relay") {
        // The relay route takes no admin credentials: NBO's own token for
        // that cluster is enough.
        const { values, pos } = parse(rest, { "confirm-billing": { type: "boolean" } }, 1);
        const id = segment(pos[0]!, "cluster id");
        confirmBilling(values, "Enabling public entry");
        print(await call("POST", `/system/clusters/${id}/relay`, { confirmBilling: true }));
        io.out(
          `The relay is being set up in the background. Check it with: nbo-server api GET /system/clusters/${id}/relay`,
        );
        return 0;
      }
      throw new UsageError("cluster needs test, update-setup or relay");
    }

    case "edge": {
      if (sub === "install") {
        const { values } = parse(
          rest,
          {
            cluster: { type: "string" },
            "admin-kubeconfig-file": fileFlag,
            context: { type: "string" },
            "confirm-billing": { type: "boolean" },
          },
          0,
        );
        const clusterId = need(values, "cluster");
        confirmBilling(values, "Installing the edge");
        const admin = await kubeconfigSource(values, "admin-kubeconfig-file");
        print(await call("POST", "/system/edge/install", { clusterId, admin, confirmBilling: true }));
        io.out("The edge is installing in the background. Follow it with: nbo-server edge status --wait");
        return 0;
      }
      if (sub === "reinstall") {
        parse(rest, {}, 0);
        print(await call("POST", "/system/edge/reinstall", {}));
        io.out("The edge is reinstalling in the background. Follow it with: nbo-server edge status --wait");
        return 0;
      }
      if (sub === "status") {
        const { values } = parse(rest, { wait: { type: "boolean" } }, 0);
        let status = await call("GET", "/system/edge");
        if (values.wait === true) {
          for (let waited = 0; jobStatus(status) === "running"; waited += pollMs) {
            if (waited >= maxWaitMs) {
              print(status);
              throw new Failed(
                "the edge job is still running after 30 minutes; check again with: nbo-server edge status",
              );
            }
            await sleep(pollMs);
            status = await call("GET", "/system/edge");
          }
        }
        print(status);
        return values.wait === true && jobStatus(status) === "failed" ? 1 : 0;
      }
      throw new UsageError("edge needs install, reinstall or status");
    }

    case "domains": {
      if (sub !== "settings") throw new UsageError("domains needs settings");
      const { values } = parse(
        rest,
        { "base-domain": { type: "string" }, "acme-email": { type: "string" }, "move-existing": { type: "boolean" } },
        0,
      );
      const body: Record<string, unknown> = {};
      if (values["base-domain"] !== undefined) body.baseDomain = values["base-domain"];
      if (values["acme-email"] !== undefined) body.acmeEmail = values["acme-email"];
      if (values["move-existing"] === true) body.moveExisting = true;
      if (Object.keys(body).length === 0) throw new UsageError("give --base-domain, --acme-email or --move-existing");
      print(await call("PATCH", "/system/domains", body));
      return 0;
    }

    default:
      return undefined;
  }
}
