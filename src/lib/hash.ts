/**
 * Shared hash utilities for the Beacon plugin.
 * Provides consistent hashing across all modules.
 */

/**
 * DJB2 hash algorithm for strings.
 * Produces a 32-bit unsigned integer.
 * 
 * @param str - The string to hash
 * @returns A 32-bit unsigned hash value
 */
export function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0;
}
