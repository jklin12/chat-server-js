module.exports = {
  apps: [{
    name: 'wa-api',
    script: './server.js',
    autorestart: true,
    max_memory_restart: '1500M',
    exp_backoff_restart_delay: 5000,
    kill_timeout: 15000,
    env: {
      PORT: 5003,
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASS: '4dmin@w4w3b',
      MSG_DELAY_MIN_MS: 3000,
      MSG_DELAY_MAX_MS: 8000
    }
  }]
};
