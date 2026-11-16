// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Long edge work (install, reinstall, enabling a cluster's relay) runs in
// the background: up to ~35 minutes of image build, load balancer and
// rollout waits must not hang on one HTTP request. The latest job per key
// is stored, so a reconnecting dashboard sees its step or its error; a job
// this process isn't running but the store says is running was cut off by
// a restart.
import { randomBytes } from "node:crypto";
import { redact } from "@nbo/deploy";
import { ErrConflict } from "../store/errors.js";
import type { EdgeJob } from "../store/server-settings.js";
import type { Store } from "../store/store.js";

export const edgeJobKey = "edge";
export const relayJobKey = (clusterId: string): string => `relay:${clusterId}`;
export const interruptedMessage = "interrupted: the control-plane restarted";
const maxErrorLength = 2000;
const unscrubbableMessage = "the job failed, and its error can't be shown safely — see the control-plane log";

export interface EdgeJobs {
  // start refuses (ErrConflict busyMessage) while key has a running job;
  // work's error is scrubbed of secrets() and recorded on the job.
  start(
    key: string,
    kind: EdgeJob["kind"],
    busyMessage: string,
    work: (onStep: (step: string) => void) => Promise<unknown>,
    secrets?: () => string[],
  ): EdgeJob;
  latest(key: string): EdgeJob | undefined;
  running(key: string): boolean;
  // settled waits for every job running now (tests).
  settled(): Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createEdgeJobs(store: Store): EdgeJobs {
  const inFlight = new Map<string, Promise<void>>();
  const save = (key: string, job: EdgeJob): EdgeJob => {
    store.setEdgeJob(key, job);
    return job;
  };

  return {
    start(key, kind, busyMessage, work, secrets = () => []) {
      if (inFlight.has(key)) throw new ErrConflict(busyMessage);
      let job = save(key, {
        id: `job_${randomBytes(8).toString("hex")}`,
        kind,
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const started = job;
      const run = (async () => {
        try {
          await work((step) => {
            job = save(key, { ...job, step });
          });
          job = save(key, { ...job, status: "succeeded", finishedAt: new Date().toISOString() });
        } catch (err) {
          // Nothing here may throw: this promise has no handler, and an
          // unhandled rejection ends the process.
          let msg = unscrubbableMessage;
          try {
            msg = redact(errText(err), secrets().filter(Boolean)).replace(
              /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
              "[redacted]",
            );
            if (msg.length > maxErrorLength) msg = `${msg.slice(0, maxErrorLength)}…`;
          } catch {
            // Unscrubbed text must not reach the log or the job.
          }
          console.error(`control-plane: edge ${kind} failed: ${msg}`);
          try {
            job = save(key, { ...job, status: "failed", error: msg, finishedAt: new Date().toISOString() });
          } catch {
            // store closed
          }
        }
      })();
      inFlight.set(key, run);
      void run.finally(() => inFlight.delete(key));
      return started;
    },

    latest(key) {
      const job = store.getEdgeJob(key);
      if (job && job.status === "running" && !inFlight.has(key)) {
        return save(key, { ...job, status: "failed", error: interruptedMessage, finishedAt: new Date().toISOString() });
      }
      return job;
    },

    running: (key) => inFlight.has(key),

    async settled() {
      await Promise.all([...inFlight.values()]);
    },
  };
}
