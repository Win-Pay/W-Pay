# GitOps

Argo CD watches this repository and reconciles the cluster from `helm/wpay`.

- `apps/wpay-api.yaml` deploys the whole chart (API, indexer, web) into `wpay`.
- Create `helm/wpay/values-production.yaml` in the deployment repository with real
  image tags, hosts and replica counts. It is intentionally absent from source
  control so environment specifics live with the platform team.

Sync is automated with pruning and self-healing. Database migrations are **not**
run by Argo CD: apply them as a pre-sync Job (`pnpm db:migrate`) or from the
release pipeline after a backup, because a failed migration must be observable
before pods roll.
