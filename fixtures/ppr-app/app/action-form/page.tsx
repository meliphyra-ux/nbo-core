// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import { cookies } from "next/headers";
import { cacheTag, revalidateTag } from "next/cache";
import { recordRun } from "../action-log";

async function Stamp() {
  "use cache";
  cacheTag("action-form");
  return <p data-testid="action-stamp">{`stamp:${Date.now()}`}</p>;
}

async function save(formData: FormData) {
  "use server";
  const name = String(formData.get("name"));
  recordRun(name);
  (await cookies()).set("ppr-action", name);
  revalidateTag("action-form", { expire: 0 });
}

// A server action on a page with no hole: a static page as far as NBO goes,
// so the POST has to get past the prerender route to the function.
export default function ActionFormPage() {
  return (
    <main>
      <h1 data-testid="action-form">action on a static page</h1>
      <form action={save}>
        <input name="name" defaultValue="from-the-form" />
        <button type="submit">save</button>
      </form>
      <Stamp />
    </main>
  );
}
