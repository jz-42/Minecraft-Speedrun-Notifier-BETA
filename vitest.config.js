/** @type {import('vitest/config').UserConfig} */
module.exports = {
  // Prevent Vite/Vitest from trying to read ignored `.env` files in this repo.
  // (Cursor sandbox blocks access to ignored files; CI also won't have them.)
  envDir: "./test/env",
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    // Cursor sandbox + Node 22 occasionally causes tinypool to crash when terminating workers.
    // Force a single-threaded pool so tests run deterministically in constrained environments.
    pool: "threads",
    poolOptions: {
      threads: { singleThread: true },
    },
    maxWorkers: 1,
  },
};
