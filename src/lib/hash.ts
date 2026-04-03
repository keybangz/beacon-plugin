/**
 * Shared hash utilities for the Beacon plugin.
 * Provides consistent hashing across all modules.
 */

/**
 * DJB2a hash algorithm for strings.
 * Uses Math.imul for correct 32-bit integer arithmetic throughout,
 * preventing intermediate float overflow on all platforms.
 * Produces a 32-bit unsigned integer.
 *
 * @param str - The string to hash
 * @returns A 32-bit unsigned hash value
 */
export function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash, 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}
