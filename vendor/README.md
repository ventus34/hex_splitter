# Browser dependency

`jszip.min.js` is JSZip **3.10.1**, copied without modifications from the published npm package (`dist/jszip.min.js`). Its license is included in `JSZip-LICENSE.markdown`.

The checked-in bundle lets the static app read ZIP files without executing scripts from a CDN. Archive exports use the streaming writer in `js/zip-writer.js`. When upgrading JSZip, update the pinned package version, lockfile, this bundle and its license together; then run the unit and browser regression suites.

File downloads use the native Blob/anchor implementation in `js/download.js`.
