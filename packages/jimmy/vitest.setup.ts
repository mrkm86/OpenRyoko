import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-worker home isolation. The globalSetup hands every fork the same temp
 * root; suites in CONCURRENT forks would then share one sessions registry, and
 * a boot sweep in one file (restart-redispatch's recoverStaleWorkflowAttempt-
 * Sessions) can stamp `interrupted` over another file's mid-turn session.
 * Runs before the test module is imported, so shared/paths.ts resolves the
 * per-process home. A test file that re-points JINN_HOME at its own mkdtemp
 * still wins — it does so before dynamically importing the modules under test.
 */
const base = process.env.JINN_HOME;
if (base) {
  const workerHome = path.join(base, `w-${process.pid}`);
  fs.mkdirSync(workerHome, { recursive: true });
  process.env.JINN_HOME = workerHome;
}
