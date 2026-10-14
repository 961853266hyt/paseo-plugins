# Paseo plugins

Plugins for [Paseo](https://paseo.sh). Each directory under `plugins/` is one self-contained plugin
with its own manifest, overview and license.

| Plugin | What it does |
| --- | --- |
| [Prompt suggestions](plugins/prompt-suggestions) | Predicts your next prompt after each agent turn. Tab accepts it on web and desktop; phones get a tap-to-send card. Needs the Claude Code CLI on the daemon host. |

## Install

From the [plugin registry](https://paseo.sh/plugins), once listed:

```bash
paseo plugin add 961853266hyt/prompt-suggestions
```

Straight from this repository:

```bash
paseo plugin install git:961853266hyt/paseo-plugins:plugins/prompt-suggestions
```

Plugins are trusted code: server code runs on the daemon host and client code runs inside the
Paseo app. Read a plugin's `OVERVIEW.md` for what it reads, sends and needs.

## Develop

```bash
npm install          # development dependencies for every plugin
npm run typecheck
npm test
```

Install a working copy into a daemon with
`paseo plugin install /absolute/path/to/plugins/<name>`, and run
`paseo plugin reload <id>` after a change.

## Versioning

Each plugin is versioned on its own. Its version lives in `plugins/<name>/package.json`, its
history in `plugins/<name>/CHANGELOG.md`, and each release gets a tag named
`<name>-v<version>`, such as `prompt-suggestions-v0.1.0`. The root `package.json` only sets up
the workspace and carries no release version.

To release a plugin: update its code, raise its version, add a changelog entry, commit, tag
`<name>-v<version>`, push the tag, and submit that tag to the registry as an update.

## Add a plugin

To add a plugin, create `plugins/<name>/` with `paseo plugin init`, give it its own
`package.json` (it joins the npm workspace automatically) and an `OVERVIEW.md`, and add it to
the table above. The registry submission source is `961853266hyt/paseo-plugins:plugins/<name>`.
