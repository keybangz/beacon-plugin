/**
 * Shared state for tracking files that failed to index.
 * Lives in a separate module to avoid circular imports between beacon.ts and tools.
 */
const failedIndexFiles = new Set<string>();

export function getFailedIndexFiles(): string[] {
  return Array.from(failedIndexFiles).slice(0, 10);
}

export function clearFailedIndexFiles(): void {
  failedIndexFiles.clear();
}

export function addFailedIndexFile(filePath: string): void {
  failedIndexFiles.add(filePath);
}

export function removeFailedIndexFile(filePath: string): void {
  failedIndexFiles.delete(filePath);
}
