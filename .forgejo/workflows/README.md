# Forgejo Actions

CI runs on the GitHub mirror (`.github/workflows`), because this Forgejo has no runners. Forgejo
reads workflows from here when this folder exists and ignores `.github/workflows`, so the jobs
don't sit queued here forever. Put a workflow here once a runner exists.
