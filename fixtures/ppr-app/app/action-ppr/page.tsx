// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { Suspense } from "react";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { recordRun } from "../action-log";

async function Greeting() {
  const name = (await cookies()).get("ppr-action")?.value ?? "nobody";
  return <p data-testid="action-greeting">{`greeting:${name}`}</p>;
}

async function save(formData: FormData) {
  "use server";
  const name = String(formData.get("name"));
  recordRun(name);
  (await cookies()).set("ppr-action", name);
  revalidatePath("/action-ppr");
}

// A server action on a PPR page: the form is in the shell, and the hole
// shows what the action set.
export default function ActionPPRPage() {
  return (
    <main>
      <h1 data-testid="action-ppr">action on a PPR page</h1>
      <form action={save}>
        <input name="name" defaultValue="from-the-form" />
        <button type="submit">save</button>
      </form>
      <Suspense fallback={<p>loading…</p>}>
        <Greeting />
      </Suspense>
    </main>
  );
}
