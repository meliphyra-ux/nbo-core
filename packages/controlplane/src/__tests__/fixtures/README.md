Test-only throwaway keys and certificates for cloudflare-check.test.ts. They protect nothing and must never be used anywhere real.
(.crt/.key rather than .pem because the repo ignores *.pem.)

pre-stages.sql is a SQL dump of a control-plane database made by the code before stages (HEAD 10137af) for migrate.test.ts: it must keep the old shape, so never regenerate it with newer code.

legacy-schema.sql is a SQL dump of a control-plane database made by the code before the core split (498eada) for legacy-upgrade.test.ts: sign-in on, the GitHub App stored, an active preview, vitals rows, and settings sealed with the key of 32 bytes 0x42. It must keep the old shape, so never regenerate it with newer code.
