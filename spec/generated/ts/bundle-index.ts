// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface BundleIndex {
    $schema?: string;
    files:    { [key: string]: BundleFileEntry };
}

export interface BundleFileEntry {
    digest: string;
    size:   number;
}
