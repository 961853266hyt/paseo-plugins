# Paseo plugins

Plugins for [Paseo](https://paseo.sh). Each directory under `plugins/` is one self-contained plugin
with its own manifest, README, overview, changelog and license.

| Plugin | What it does |
| --- | --- |
| [Prompt suggestions](plugins/prompt-suggestions) | Predicts your next prompt after each agent turn. Tab accepts it on web and desktop; phones get a tap-to-send card. Needs the Claude Code CLI on the daemon host. |
| [Better btw](plugins/better-btw) | Claude Code's `/btw`: ask about an agent's conversation without interrupting it; the answer never enters its history. Needs the Claude Code CLI on the daemon host. |

## Install

Prompt suggestions is listed in the [plugin registry](https://paseo.sh/plugins), which installs
the reviewed version:

```bash
paseo plugin add 961853266hyt/prompt-suggestions
```

From npm, which has each release as soon as it is published:

```bash
paseo plugin install npm:paseo-prompt-suggestions
paseo plugin install npm:paseo-better-btw
```

Straight from this repository:

```bash
paseo plugin install git:961853266hyt/paseo-plugins:plugins/prompt-suggestions
paseo plugin install git:961853266hyt/paseo-plugins:plugins/better-btw
```

Update any of them with `paseo plugin update <id>`, such as `paseo plugin update better-btw`.
A registry install moves to a new version only after the registry approves it, so it can trail npm
for a while.

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

Each plugin is versioned on its own. Its version lives in `plugins/<name>/package.json` and in
that workspace's entry in the root `package-lock.json`, its history in
`plugins/<name>/CHANGELOG.md`, and each release gets a tag named `<name>-v<version>`, such as
`prompt-suggestions-v0.2.2`. The root `package.json` only sets up the workspace and carries no
release version.

Each plugin's directory is published to npm as its own package, such as
`paseo-prompt-suggestions`. Its registry record pins an npm version, and the registry checks npm
twice a day and opens an update for review when a new version appears. Nothing has to be
submitted by hand after the first listing.

## Release a plugin

1. Update the code, raise the version in the plugin's `package.json` and the root
   `package-lock.json`, and add a changelog entry. When the plugin's behaviour changes, update
   both `README.md`, which npm shows, and `OVERVIEW.md`, which the registry shows. Install
   commands belong in the README only: the registry rejects them in an overview.
2. Run `npm run typecheck` and `npm test`, then `npm publish --dry-run` in the plugin's
   directory to check the files that will ship.
3. Commit, tag `<name>-v<version>`, and push the commit and the tag.
4. In the plugin's directory, check `npm whoami`. Logins expire, so if it fails, sign in again
   with `npm login --auth-type=web` and open the link within about five minutes.
5. Run `npm publish` in a terminal. The account confirms writes with a passkey, so npm prints a
   link to approve the publish in the browser. It does that only when its input and output are a
   terminal; from a script or an agent it fails with `EOTP` instead, unless wrapped in `script`.

A `404 Not Found - PUT` from `npm publish` means the login has expired, not that the package is
missing.

## Add a plugin

Create `plugins/<name>/` with `paseo plugin init` and give it its own `package.json` (it joins
the npm workspace automatically; drop `"private": true` so npm accepts it), an `OVERVIEW.md`, a
`README.md`, a `CHANGELOG.md` and a license, and add it to the table above. Publish it to npm,
then submit the npm package through the
[registry submission form](https://github.com/getpaseo/plugins) to get it listed.
