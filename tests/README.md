# Tests

Install the exact dependencies with `npm ci`. Then run the complete Node and browser suite with `npm test`,
or only the fast unit/static-server tests with `npm run test:unit`.
Playwright uses its bundled Chromium by default. Set `CHROME_CHANNEL=chrome` (or another Playwright-supported
Chrome channel) to use an installed browser. On a fresh machine, install Chromium with
`npx playwright install chromium` first. CI installs Chromium and runs the same `npm test` command.

The browser regressions cover project save/reload/import with image rotation, valid zero-valued settings, rejected
imports preserving in-memory and IndexedDB state, rollback of failed IndexedDB replacement, text-only rendering of
untrusted image names, PNG/frame/relief ZIP entries, native STL downloads, numeric bounds, mobile canvas sizing,
and renderer bounding-box work as the grid grows. Desktop regressions also cover undo/redo controls and shortcuts,
history resets after library changes/reset, crop and grid restoration, one-editor-per-origin ownership and
takeover, the IndexedDB lease fallback, and export cancellation.

Streaming ZIP unit tests use an in-memory sink to check ZIP32 records, UTF-8 entry names, CRCs, archive bounds,
abort behavior, and that each awaited sink write applies backpressure. Browser integration tests cover PNG, frame STL,
relief STL, and `.hexproj` exports, picker user activation, archive integrity and import round trips, progress ordering,
cancellation, I/O failures, and the 256 MiB download fallback. Most tests replace the save picker with a
`WritableStream` sink stub so they can inject delays and errors deterministically. A separate browser regression
uses the browser's real Origin Private File System (OPFS) file handle and native `createWritable()` implementation:
it reads back a valid ZIP and checks that aborting or failing a write preserves the previously committed OPFS file.
The picker itself is stubbed to return that OPFS handle, so the test does not automate the operating system's save
dialog or write to a user-selected disk location.

Pure unit tests also cover bounded history, export Worker protocols, deterministic AMS quantization, mesh geometry,
project validation, and static-server boundaries.

Browser tests run against a temporary localhost server in isolated contexts. `tests/helpers/poll.js` contains
`waitForAsyncPageCondition` for predicates that read IndexedDB: Playwright 1.62.1's `page.waitForFunction` treats an
async predicate's returned Promise as truthy rather than waiting for its resolution, so that API does not reliably
poll asynchronous IndexedDB checks. The helper evaluates the async predicate repeatedly until it succeeds or times out.
