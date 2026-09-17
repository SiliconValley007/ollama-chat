const path = require('path');
const isPkg = typeof process.pkg !== 'undefined';
// Packaged: resolve next to the .exe. Source: resolve to this repo's root.
const APP_ROOT = isPkg ? path.dirname(process.execPath) : __dirname;
module.exports = { APP_ROOT, isPkg };