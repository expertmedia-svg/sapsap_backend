module.exports = {
  apps: [
    {
      name: "sapsap-api",
      cwd: __dirname,
      script: "dist/apps/api/src/main.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      min_uptime: "10s",
      max_restarts: 10,
      max_memory_restart: "750M",
      kill_timeout: 15000,
      time: true,
    },
  ],
};
