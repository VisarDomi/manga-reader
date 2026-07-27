Usage:
node scripts/build.mjs                    – all → dist/manga-reader.user.js
node scripts/build.mjs asura              – only asura → dist/asura-reader.user.js
node scripts/build.mjs -asura             – all except → manga-reader.user.js
node scripts/build.mjs asura,qimanga      – only those → manga-reader.user.js
node scripts/build.mjs -asura,qimanga     – all except → manga-reader.user.js
node scripts/build.mjs --no-increase-version – build without changing package version