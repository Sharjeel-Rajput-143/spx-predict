import os from "node:os";
import path from "node:path";

// The automation engine's JSON store writes to process.cwd()/data/automation
// by default - the same files `npm run dev` uses. Point the test suite at a
// throwaway directory instead so running tests never clobbers real app data.
process.env.AUTOMATION_DATA_DIR = path.join(os.tmpdir(), `spx-predict-automation-test-${process.pid}`);
