// Types for scripts/bundle.mjs, for the test that imports it.
export interface BundleManifest {
  name: string;
  version: string;
  title: string;
  tagline: string;
  publisher: string;
  sequence: number;
  files: { path: string; size: number; sha256: string }[];
  sources?: string[];
  [key: string]: unknown;
}
export interface Listing {
  ref: string;
  sequence: number;
  digest: string;
  urls: string[];
  title: string;
  tagline: string;
  category: string;
  developer: string;
  submitter: string;
  repo: string;
  support: string;
}
export const PUBLISHER: string;
export const REPO: string;
export const BUNDLE: string;
export const SOURCE: string;
export function readManifest(bytes: Uint8Array): { manifest: BundleManifest; digest: string };
export function digestOf(manifest: Record<string, unknown>): string;
export function expected(source: Record<string, unknown>, page: Uint8Array, sequence: number, publisher?: string): BundleManifest;
export function problems(manifest: BundleManifest, source: Record<string, unknown>, page: Uint8Array): string[];
export function listing(manifest: BundleManifest, digest: string, commit: string): Listing;
