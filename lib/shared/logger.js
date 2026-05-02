/**
 * Tiny logger shim. Accepts:
 *   - true / undefined  -> log to console
 *   - false / null      -> silent
 *   - object with {info, warn, error, success?, debug?} methods -> use as-is
 *
 * Always returns an object exposing info / warn / error / success / debug.
 */
function makeLogger(input, prefix = '') {
    if (input === false || input === null) return silent;
    if (input && typeof input === 'object') return wrap(input, prefix);
    return wrap(console, prefix);
}

const silent = {
    info() {}, warn() {}, error() {}, success() {}, debug() {},
};

function wrap(target, prefix) {
    const tag = prefix ? `[${prefix}] ` : '';
    const method = (name, fallback) => (...args) => {
        const fn = typeof target[name] === 'function' ? target[name] : fallback;
        if (fn) fn.call(target, tag ? tag + String(args[0] ?? '') : args[0], ...args.slice(1));
    };
    return {
        info: method('info', target.log),
        warn: method('warn', target.log),
        error: method('error', target.log),
        success: method('success', target.log || target.info),
        debug: method('debug', target.log || (() => {})),
    };
}

module.exports = {makeLogger};
