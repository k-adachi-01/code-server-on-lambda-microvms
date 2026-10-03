// Shared property-based-testing conventions (R16.5).
//
// Every [PBT] property runs at least 100 cases, and every property test title
// follows one format so the suite maps 1:1 onto the numbered properties in the
// design document.

import { type Parameters } from "fast-check";

export const FEATURE_NAME = "lambda-microvm-code-server";

/** Minimum fast-check runs for every property test (R16.5). */
export const NUM_RUNS = 100;

/**
 * fast-check parameters shared by every property test. `numRuns` is >= 100 as
 * required; callers may spread and override other fields as needed.
 */
export const pbtParams: Parameters<unknown> = {
  numRuns: NUM_RUNS,
};

/**
 * Build the canonical property-test title:
 *   `Feature: lambda-microvm-code-server, Property N: <title>`
 *
 * @param n     the design Property number (e.g. 4 for "Property 4")
 * @param title the human-readable property name
 */
export function propertyTitle(n: number, title: string): string {
  return `Feature: ${FEATURE_NAME}, Property ${n}: ${title}`;
}
