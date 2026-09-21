const fs = require('node:fs/promises');
const path = require('node:path');

Promise.all([
  fs.rm(path.resolve(__dirname, '..', 'release'), { recursive: true, force: true }),
  fs.rm(path.resolve(__dirname, '..', '.build-staging'), { recursive: true, force: true }),
]).then(() => console.log('release and staging directories removed'));
