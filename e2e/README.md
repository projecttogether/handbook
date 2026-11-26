# End-to-end tests

A real browser against the built app, signing in through Keycloak.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL, Keycloak
npm run build
npx playwright install chromium            # once
npm run test:e2e
```

The app runs on port 3000 with a fresh database (`handbook_e2e`),
`ADMIN_EMAILS=ada@example.org` and `ACCESS_GROUPS=/staff`. The test users are
listed in `compose.dev.yaml`.
