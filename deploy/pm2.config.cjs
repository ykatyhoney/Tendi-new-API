// pm2 app for the Family API test site on the VPS (tendi_family_dev only, never production).
//
//   npm run build
//   pm2 start deploy/pm2.config.cjs && pm2 save
//
// The API listens on 127.0.0.1 only. nginx (deploy/nginx-family-api-test.conf) is the public side: HTTPS on 8443
// and a username/password. DB settings and passwords come from .env; the values below override it.
// NODE_ENV stays development so /docs (Swagger UI) is served; production turns it off.
const NODE26 = process.env.NODE26_BIN ?? '/opt/node-v26.13.0-linux-x64/bin/node'

module.exports = {
  apps: [
    {
      name: 'tendi-family-api',
      cwd: __dirname + '/..',
      script: 'dist/server.js',
      interpreter: NODE26,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '3100',
        DB_NAME: 'tendi_family_dev',
        // nginx on the same host is the only proxy, so request.ip (and the per-IP rate limit) is the client.
        TRUST_PROXY: '127.0.0.1',
      },
    },
  ],
}
