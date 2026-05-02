function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const eq = a.indexOf('=');
        if (eq !== -1) {
            out[a.slice(2, eq)] = a.slice(eq + 1);
        } else {
            const next = argv[i + 1];
            out[a.slice(2)] = (next && !next.startsWith('--')) ? argv[++i] : 'true';
        }
    }
    return out;
}

module.exports = {parseArgs};
