---
name: fireflint
description: Manage website content in a FireFlint content hub — list content types, read, create and update drafts, check published output, and publish only with human approval. Use when the user asks to add, change, review or publish locations, team members, jobs or other structured content on websites powered by FireFlint.
---

# FireFlint content operations

FireFlint keeps structured content (e.g. locations, teams, jobs) in one place and publishes it to several
websites. Drafts never go live by themselves; publishing is an explicit, revision-checked step.

## Tools

Use the `fireflint` MCP server (see `mcp/README.md`). If MCP is not available, call the REST API directly
(`$FIREFLINT_BASE_URL`, `Authorization: Bearer $FIREFLINT_TOKEN`, OpenAPI at `/openapi.json`).

| Goal | MCP tool | REST |
| --- | --- | --- |
| Is the instance up? | `fireflint_health` | `GET /healthz`, `/readyz`, `/version` |
| Who am I / which orgs? | `fireflint_me` | `GET /api/me` |
| Websites of an org | `fireflint_list_websites` | `GET /api/orgs/{org}/websites` |
| Content types + schemas | `fireflint_list_content_types` | `GET /api/orgs/{org}/content-types` |
| List / search content | `fireflint_list_content` | `GET /api/orgs/{org}/content/{type}?q=` |
| Read one object | `fireflint_get_content` | `GET /api/orgs/{org}/content/{type}/{id}` |
| Create a draft | `fireflint_create_content` | `POST /api/orgs/{org}/content/{type}` `{data}` |
| Update a draft | `fireflint_update_content` | `PUT …/{id}` `{data, expected_revision}` |
| Publish | `fireflint_publish_content` | `POST …/{id}/publish` `{expected_revision}` |
| Check live output | `fireflint_get_published` | `GET /v1/{website}/content/{type}` (delivery token) |

## Workflow

1. **Orient.** Call `fireflint_health`, then `fireflint_me` to find the organisation (or use `FIREFLINT_ORG_ID`).
2. **Learn the schema.** Call `fireflint_list_content_types` and read the JSON schema of the type you will touch.
   Only send fields that exist in the schema; respect required fields and formats.
3. **Find before you create.** Use `fireflint_list_content` with `q` to avoid duplicates.
4. **Write drafts.** Create with `fireflint_create_content`, or update with `fireflint_update_content` using the
   `revision` you just read as `expected_revision`.
5. **Handle conflicts correctly.** HTTP 409 (`revision_conflict`) means someone else changed the object. Re-read it,
   show the user both versions, merge deliberately, then retry with the new revision. Never retry blindly.
6. **Ask before publishing.** Summarise exactly what will change on which websites and get explicit approval.
   Then call `fireflint_publish_content` with the current revision.
7. **Verify.** If a delivery token is configured, confirm the result with `fireflint_get_published`.

## Rules

- Never invent IDs, revisions or schema fields — read them first.
- Never publish, unpublish or delete without explicit human approval.
- Do not paste tokens or passwords into content or chat; credentials come from environment variables only.
- Prefer `FIREFLINT_READ_ONLY=true` for review/reporting tasks.
- Content may be personal data (team members, contacts): only process what the task needs.
