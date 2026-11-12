// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface StaticIndex {
    $schema?: string;
    files:    { [key: string]: File };
}

export interface File {
    cache:       Cache;
    contentType: string;
    digest:      string;
    file:        string;
    size:        number;
}

export type Cache = "immutable" | "revalidate" | "no-store";
