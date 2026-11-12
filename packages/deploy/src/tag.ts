// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

// imageTagSuffix strips the "sha256:" prefix and keeps the first 12
// hex characters of a content id — the truncation both deploy
// targets use for a human-readable, reasonably-unique Docker image
// tag. This is deliberately NOT the same length as
// @nbo/adapter-cloudrun's own contentIDLabel (32 hex characters, a
// GCP label-storage constraint): an image tag has no such limit, 12
// characters is just what cmd/nbo/deploy.go's own image-tagging code
// already used, kept as-is rather than widened.
export function imageTagSuffix(contentID: string): string {
  const hex = contentID.startsWith("sha256:") ? contentID.slice("sha256:".length) : contentID;
  return hex.slice(0, 12);
}

// appImageTag is the tag suffix of an app image: the content id's 12 hex, plus
// "-c<carry hash>" when the image carries the previous build's files, plus
// "-b<baked hash>" (adapter-k8s appBakedHash: NBO's code, /functions.json,
// /env.json). Without them, IfNotPresent could start a node's older image of
// the same build, e.g. one made before an NBO upgrade. Nothing parses the tag:
// the "already live" check reads the content-id annotation or label.
export function appImageTag(contentID: string, carryHash: string, bakedHash: string): string {
  const carry = carryHash === "" ? "" : `-c${carryHash}`;
  return `${imageTagSuffix(contentID)}${carry}-b${bakedHash}`;
}
