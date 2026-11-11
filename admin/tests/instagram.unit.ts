import { strict as assert } from "node:assert";
import { test } from "node:test";
import { instagramAuthorizationUrl, instagramError, instagramState } from "../src/lib/instagram";

test("Instagram redirects accept only Meta's fixed authorization endpoint", () => {
  assert.equal(instagramAuthorizationUrl("https://www.instagram.com/oauth/authorize?client_id=123&state=opaque"), "https://www.instagram.com/oauth/authorize?client_id=123&state=opaque");
  for (const value of ["javascript:alert(1)", "https://evil.test/oauth/authorize", "https://www.instagram.com.evil.test/oauth/authorize", "https://user:password@www.instagram.com/oauth/authorize", "http://www.instagram.com/oauth/authorize", "https://www.instagram.com:8443/oauth/authorize", "https://www.instagram.com/accounts/login/"]) assert.equal(instagramAuthorizationUrl(value), null);
});
test("Unknown publication outcomes stay visible and do not promise retries", () => {
  assert.equal(instagramState("outcome_unknown"), "Ergebnis ungeklärt");
  assert.match(instagramError("instagram_outcome_unknown"), /kein automatischer erneuter Versand/);
  assert.match(instagramError("instagram_not_configured"), /noch nicht eingerichtet/);
  assert.doesNotMatch(instagramError("provider error with secret"), /secret/);
});


test("Unified authorization is explicit and cannot fall back to the Instagram host", () => {
  const unified="https://www.facebook.com/dialog/oauth?client_id=123&config_id=789&response_type=code";
  assert.equal(instagramAuthorizationUrl(unified,"unified"),unified);
  assert.equal(instagramAuthorizationUrl(unified),null);
  assert.equal(instagramAuthorizationUrl("https://www.instagram.com/oauth/authorize?client_id=123","unified"),null);
  assert.equal(instagramAuthorizationUrl("https://www.facebook.com/dialog/oauth?client_id=123","unified"),null);
});
