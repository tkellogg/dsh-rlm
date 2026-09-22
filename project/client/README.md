# @dsh-rlm/jev-settings

Browser-side Jev Judge settings for DeepSeek Harness. This package is deliberately a
client-only contribution: it does not edit DSH core or the Web shell and has no Host
`apply` behavior. The parent plugin supplies the public `jev` settings namespace and
`jev/status` and `jev/testConnection` Gateway methods.

## Build

```sh
npm install
npm run build
npm test
```

The generated [`lib/client.js`](lib/client.js) is a DSH lazy-CJS browser module
(`window.__ModuleLoader__.load`), not ordinary ESM. Install and enable the package
as a normal Host Loader plugin. For a checkout, mount `lib/index.js` (the no-op Host
entry), never the browser bundle itself. DSH discovers `dsh.client` in the nearest
package manifest and serves its `./client` export. The parent source profile
already includes this entry. Restart the existing Host and refresh the GUI.

The UI contributes a `settings.section` row labelled **Jev Judge**. It stages the
public `jev` settings namespace (enabled, `apiKeyEnv`, model, timeout, and HTTPS root)
and keeps the API key write-only through `remote.credentials`. Status is read from the
fixed no-argument `jev/status` RPC. The explicit test button calls fixed
`jev/testConnection` only when the form is clean, enabled, and configured; opening the
settings page never performs a provider request.
