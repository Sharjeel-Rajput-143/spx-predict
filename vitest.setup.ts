import os from "node:os";
import path from "node:path";

// The automation engine's JSON store writes to process.cwd()/data/automation
// by default - the same files `npm run dev` uses. Point the test suite at a
// throwaway directory instead so running tests never clobbers real app data.
process.env.AUTOMATION_DATA_DIR = path.join(os.tmpdir(), `spx-predict-automation-test-${process.pid}`);

// Orders on the mock executor fill instantly, so poll for the fill quickly
// instead of waiting the production 2s between checks.
process.env.AUTOMATION_ORDER_POLL_INTERVAL_MS = "10";

// Flushing every write to disk is for real hosts; the test suite writes thousands of small files.
process.env.AUTOMATION_STORAGE_FSYNC = "false";

// The live bot's own records (its switch, settings and ledger) live in a separate folder; tests get a throwaway one too.
process.env.LIVE_DATA_DIR = path.join(os.tmpdir(), `spx-predict-live-test-${process.pid}`);
