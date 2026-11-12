// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

import Link from "next/link";

// Client-side <Link>s to the PPR page: the request they make carries `rsc`,
// and the hole has to arrive in that answer. One prefetches the static part
// first, which is the default; the other goes straight to the navigation.
export default function NavPage() {
  return (
    <main>
      <h1 data-testid="nav-page">navigation start</h1>
      <Link href="/visitor" prefetch={false} data-testid="to-visitor">
        to the visitor page
      </Link>
      <Link href="/visitor" data-testid="to-visitor-prefetched">
        to the visitor page, prefetched
      </Link>
    </main>
  );
}
