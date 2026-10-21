# Switch environments

Each file in `.routelens/environments/` is an environment, for example `local.env.json` and `staging.env.json`. Requests use its variables, like `{{baseUrl}}`.

Click the environment name in the status bar (bottom left) to switch. Your choice is saved for this workspace in VS Code, not in your repo.

Environment files are committed to Git, so **never put secrets in them**.
