/**
 * Plugin-wide structured logger.
 *
 * Wraps `client.app.log` from the OpenCode SDK so every module can call
 * `log.warn(...)` / `log.error(...)` / `log.info(...)` / `log.debug(...)`
 * without holding a reference to `client`.
 *
 * Usage (3-arg form):
 *   import { log } from "./logger.js";
 *   log.warn("beacon", "Something went wrong", { detail: err.message });
 *
 * Usage (2-arg form - service defaults to "beacon"):
 *   import { log } from "./logger.js";
 *   log.warn("Something went wrong", { detail: err.message });
 *
 * Call `initLogger(client)` once at plugin startup (plugin.ts) before any
 * module that uses `log` is exercised.
 */
let _client = null;

/**
 * Wire the SDK client into the logger. Call once from plugin.ts immediately
 * after the Plugin function receives its `input` argument.
 */
export function initLogger(client) {
    _client = client;
}

function send(level: string, service: string, message: string, extra?: Record<string, unknown>): void {
    if (_client) {
        // Fire-and-forget — logging must never block the call site.
        _client.app.log({
            body: { service, level, message, extra },
        }).catch(() => {
            // Swallow SDK errors silently; we cannot log them without risking recursion.
        });
    }
    // Intentionally no console fallback — console.* is prohibited in this plugin.
}

// 3-arg form: (service, message, extra?)
export const log = {
    debug: (service: string, message: string, extra?: Record<string, unknown>) => send("debug", service, message, extra),
    info: (service: string, message: string, extra?: Record<string, unknown>) => send("info", service, message, extra),
    warn: (service: string, message: string, extra?: Record<string, unknown>) => send("warn", service, message, extra),
    error: (service: string, message: string, extra?: Record<string, unknown>) => send("error", service, message, extra),
};
