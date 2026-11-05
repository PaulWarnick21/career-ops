@AGENTS.md

<!-- Add Claude Code-specific guidance here only when it has no AGENTS.md counterpart. -->

## This fork: restore before first-run setup

This is a personal fork. The owner's CV, config, tracker and job-search automation live in a private companion repo, `PaulWarnick21/career-ops-config`, checked out over this one.

- **`cv.md` missing here means a fresh clone, not a new user.** Don't run `doctor.mjs` or start onboarding, because `doctor.mjs` copies template files into place. Read the restore guide in the private repo first and walk the owner through it:

  ```bash
  git clone --bare https://github.com/PaulWarnick21/career-ops-config.git ../career-ops-config.git
  git --git-dir=../career-ops-config.git show main:.career-ops-config-README.md
  ```

- **`data/.auto-scan.pause` means automation was switched off on purpose.** Leave it off unless the owner asks. To turn it back on, run `powershell -ExecutionPolicy Bypass -File .\automation.ps1 resume` (`status` and `pause` work the same way). The private repo's guide covers this under "Pausing and resuming automation".
