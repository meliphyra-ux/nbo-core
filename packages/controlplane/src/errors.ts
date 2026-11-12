// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// Split into their own file so both store.ts and cron.ts can import
// them without creating a circular dependency — cron.ts's own
// functions extend the same Store interface store.ts defines (Go's
// cron.go adds methods directly to the same *Store struct, same
// package, no such concern), so store.ts's own createStore needs to
// call into cron.ts at runtime while cron.ts needs these error
// classes; neither file needs the other for these.
export class ErrNotFound extends Error {}
export class ErrDuplicateName extends Error {}
export class ErrInvalidEnvironmentConfig extends Error {}
export class ErrInvalidGitConfig extends Error {}
export class ErrInvalidEnvVar extends Error {}
// Generic bad input (maps to 400); used by platform settings and domains.
export class ErrInvalid extends Error {}
// The request conflicts with the current state (maps to 409).
export class ErrConflict extends Error {}
