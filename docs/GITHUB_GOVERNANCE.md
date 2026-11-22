# GitHub governance

Last checked: 2026-11-22. This page records what is configured, what is blocked,
and the exact owner steps. It does not claim that protections are enabled.

## Current state

| Control | Status | Evidence |
| --- | --- | --- |
| CI on `main` | PASS | CI run 45067193267 and Security run 45067193233 succeeded on `b9bdba4`; 11/11 check runs completed, none skipped |
| Dependency review | Configured | `.github/workflows/dependency-review.yml`; PR-only by design |
| CodeQL, Trivy, Gitleaks, dependency audit | Configured | `.github/workflows/security.yml`; green in run 45067193233 |
| Branch protection on `main` | **BLOCKED** | `GET /repos/Win-Pay/W-Pay/branches/main/protection` returns `403 Resource not accessible by integration` with the current token |
| Force-push / deletion protection | **NOT VERIFIED** | Requires the same branch-protection API/UI access |
| Required reviews / conversation resolution | **NOT VERIFIED** | Same |
| Required signed commits | **NOT CONFIGURED/VERIFIED** | No signed-commit evidence in this workspace |
| `production` environment | Exists, unprotected | API reports `protection_rules: []`, `can_admins_bypass: true`, no deployment branch policy |
| Production secrets | **BLOCKED** | Environment secret names return `403` with the current token; last backup run failed because `DATABASE_URL` is absent |
| Contributor issues | PASS | Genuine scoped issues [#1](https://github.com/Win-Pay/W-Pay/issues/1), [#2](https://github.com/Win-Pay/W-Pay/issues/2), [#3](https://github.com/Win-Pay/W-Pay/issues/3) opened; no synthetic activity |

The token used here has repository admin permissions in the API response but is
not granted the branch-protection or environment-secret scopes. Do not treat the
repository admin flag as proof that protections are enabled.

## Required checks

Use the job names that GitHub reports, not workflow names:

- `Soroban contracts`
- `Rust dependency audit`
- `TypeScript workspace`
- `Browser wallet flow`
- `k6 load test`
- `Container build (api, infra/docker/api.Dockerfile)`
- `Container build (indexer, infra/docker/indexer.Dockerfile)`
- `Gitleaks`
- `CodeQL (javascript-typescript)`
- `Dependency audit`
- `Trivy filesystem scan`

Dependency review runs only on pull requests. Do not add it as a required check
for pushes; it would never report.

## Owner runbook: protect `main`

Requires a token with **Administration: read and write** on the repository
(a classic PAT with `repo` + admin rights, or a GitHub App with the equivalent
permission). The commands below were **not** executed here.

```bash
cat > /tmp/wpay-main-protection.json <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Soroban contracts",
      "Rust dependency audit",
      "TypeScript workspace",
      "Browser wallet flow",
      "k6 load test",
      "Container build (api, infra/docker/api.Dockerfile)",
      "Container build (indexer, infra/docker/indexer.Dockerfile)",
      "Gitleaks",
      "CodeQL (javascript-typescript)",
      "Dependency audit",
      "Trivy filesystem scan"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
gh api -X PUT repos/Win-Pay/W-Pay/branches/main/protection \
  --input /tmp/wpay-main-protection.json
```

Then verify:

```bash
gh api repos/Win-Pay/W-Pay/branches/main/protection \
  --jq '{enforce_admins: .enforce_admins.enabled, force: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled, checks: .required_status_checks.contexts}'
```

If signed commits are required, enable **Require signed commits** in the same
settings page and confirm every contributor has a signing key configured. Do not
turn it on without warning contributors first.

## Owner runbook: protect `production`

The environment exists but is unprotected. In **Settings > Environments >
production**:

1. Add required reviewers (the repository owner plus one other person where
   available).
2. Set **Deployment branches and tags** to `main` only.
3. Disable admin bypass if the plan permits it.
4. Add `DATABASE_URL` and `BACKUP_GPG_PASSPHRASE` as environment secrets with
   `gh secret set ... --env production` (prompts without echoing).
5. Run `gh workflow run backup.yml --ref main` and require all jobs to pass
   before marking production backup PASS.

The current token cannot read or write these secrets; see
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md#enabling-production-backups) for the
full acceptance criteria.

## Contributor readiness

- The scoped backlog is [CONTRIBUTOR_ISSUES.md](CONTRIBUTOR_ISSUES.md); issues
  #1–#3 are the currently filed subset.
- Issue and pull-request templates exist under `.github/`.
- CI must be green before merge once protection is enabled.
- Do not open issues, comments or commits solely to produce Drips Wave activity.
  Evidence must correspond to real work.

## Verification commands

```bash
gh run list --workflow=ci.yml --limit 3
gh run list --workflow=security.yml --limit 3
gh api repos/Win-Pay/W-Pay/branches/main/protection
gh api repos/Win-Pay/W-Pay/environments/production
gh issue list --state open
```

Record the date, run ids and exact output in the engineering report after any
change. A green CI run does not prove branch protection, and an unprotected
environment does not prove secrets are absent or present.
