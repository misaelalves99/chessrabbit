# Security

The default stack binds web, API, PostgreSQL and Redis to 127.0.0.1. LOCAL_MODE bypasses registration for personal use and accepts session bootstrap only from APP_BASE_URL. The API refuses LOCAL_MODE in production or with a non-loopback app origin. Run a single API process when using an automatically generated signing secret.

Do not expose local mode on a network. Shared hosting uses regular accounts with LOCAL_MODE=false, a persistent strong JWT secret, HTTPS, configured email, protected backend services and appropriate backups. The normal access-token/refresh-token and separate admin-token boundaries remain.

Engine profiles are trusted local files and can launch processes. Only install engines and networks from sources you trust. The browser can submit a profile id and analysis parameters, never an executable path or UCI options.

Credentials, downloaded engines, networks, backups and local configuration are ignored by Git. Do not commit them. Keep runtimes and dependencies updated.

Report a vulnerability privately to the repository maintainer through GitHub's private vulnerability reporting when enabled.
