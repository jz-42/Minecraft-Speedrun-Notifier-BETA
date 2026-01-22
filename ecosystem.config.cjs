module.exports = {
  apps: [
    {
      name: "runalert-watcher",
      script: "src/watcher/run_watcher.js",
      env: {
        REMOTE_CONFIG_URL:
          "https://minecraft-speedrun-notifier.onrender.com/config",
        REMOTE_CONFIG_POLL_MS: "5000",
        AGENT_REPO_URL: "https://github.com/<org>/runAlert",
      },
    },
  ],
};
