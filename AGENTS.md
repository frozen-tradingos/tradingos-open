# Trading OS Open — project boundaries

- Work only in this independent package. Do not read, write, link, start, stop or probe any personal Trading OS checkout, its data, credentials, processes, ports or scheduled tasks.
- Candidate source is a whitelist export of fixed commits, without Git history, private data or credentials. Never copy `.env`, runtime data, auth profiles, logs, screenshots, original personal plans or provider responses into distributable files.
- Broker tools remain strictly read-only. No Discord, automated execution, account custody, autonomous deployment or production service tasks.
- New users must authorize their own supported broker, data sources and model account. Missing/expired authorization or insufficient/stale data must fail closed, never fall back to sample predictions.
- Keep demo/test artifacts explicitly synthetic and outside natural performance statistics. No live provider/model calls during package tests.
- Use the smallest change, existing helpers, stdlib and locked dependencies. Leave a runnable check for nontrivial logic.
- Use project-local paths and independent data. Do not bind or request ports4070–4076. The application candidate uses loopback4160; tests may request OS-assigned loopback ports.
- Publish only the checked source allowlist after an explicit Owner request. The Owner has approved MIT for the original source; third-party licenses remain separate.
- Local working files, test evidence and generated installation data stay under this project and are excluded from the public ZIP.
