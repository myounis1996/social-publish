const instagram = require('./lib/instagram');
const tiktok = require('./lib/tiktok');
const {loadCookies, requireCookies} = require('./lib/shared/cookies');

module.exports = {
    instagram,
    tiktok,
    loadCookies,
    requireCookies,
};
