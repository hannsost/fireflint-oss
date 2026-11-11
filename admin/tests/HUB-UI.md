# Isolated company hub UI regressions

Run only against `E2E_DATABASE=hub` (API28090/Admin25174/PostgreSQL25433).
The main task owns API builds, fixture lifecycle and the shared browser slot.
The suites create unique fixture organisations and scoped users. Cleanup never
selects arbitrary organisations. Traces are disabled because requests contain
session tokens; screenshots capture visual evidence only.

From `admin/`, after the API is ready with all hub migrations/routes:

```sh
E2E_DATABASE=hub PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium CI=1 npm run e2e -- \
  tests/hub-ui.spec.ts tests/hub-ui-forms.spec.ts \
  tests/hub-ui-resources.spec.ts tests/hub-ui-integrations.spec.ts \
  --reporter=list --output=test-results-hub-ui
```

- `hub-ui.spec.ts`: module dependencies, record relationships/history/archive,
  stale CAS and navigation drafts, organisation isolation, viewer writes, mobile,
  >100-row active+archived custom-kind export, import preview, and two mocked OIDC
  browser-protocol cases (single-use proof/URL removal and local login fallback),
  a late save across organisation switches, and a held old token refresh across
  a new OIDC login. Neither response may replace the new view/session.
- `hub-ui-forms.spec.ts`: actual builder/public form/inbox/history, lost-response
  idempotency, version conflict, editor draft retention, assigned two-person
  decisions/comments/notifications and viewer controls. Uses a synthetic owner
  independent of demo credentials.
- `hub-ui-resources.spec.ts`: actual booking overlap/CAS/cancel/calendar,
  source/translation revision races, and media metadata/usages conflicts.
- `hub-ui-integrations.spec.ts`: owner custom schema builder and revision races,
  JSON fixture connectors/mapping/preview/apply and atomic row conflicts.

The OIDC UI protocol mocks are not a real external provider acceptance. Backend
OIDC/Keycloak and connector-provider acceptance belong to the respective tasks.
Core fixture suites use `local-fixture.ts` credentials for the isolated fixture;
no external account or real customer data is required.

The auth/cache integration also requires the existing `account-security.spec.ts`
and `content-publication-ui.spec.ts` browser regressions. Run them in the same
coordinated slot, with a separate output directory to preserve other tasks'
evidence. The password-change test creates its own editor and viewer; it never
changes the demo owner's credentials.
