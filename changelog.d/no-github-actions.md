### Maintenance
- No GitHub Actions automation is left: the CI, Website, Release, remote-bundle and Windows install
  workflows, Dependabot and the self-hosted runner are removed, and so is `bun run check`'s workflow
  syntax step. `bun run check` is the gate; releases, the website and the remote-PC bundles are made
  by hand (docs/development.md, Releasing).
