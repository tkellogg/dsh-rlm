window.__ModuleLoader__.load({
  id: "@dsh-rlm/onboarding",
  factory: (require) => {
    const React = require("react");
    const { Modal } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const subscriptions = new Set(["codex", "claude", "grok", "copilot", "antigravity"]);
    const unwrap = r => { if (!r?.ok) throw new Error("Host request failed"); return r.value; };
    const at = (value, path) => path.reduce((v, key) => v?.[key], value);
    const emptyCatalog = () => ({groups:[],failures:[]});
    const mergeWarnings = (...groups) => [...new Set(groups.flat().filter(Boolean))];
    const withTimeout = (promise, milliseconds) => {
      if (typeof setTimeout !== "function") return Promise.resolve(promise);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out")), milliseconds);
        Promise.resolve(promise).then(
          value => { clearTimeout(timer); resolve(value); },
          error => { clearTimeout(timer); reject(error); }
        );
      });
    };
    const attempt = async (warnings, label, fn, fallback, timeout=15000) => {
      try { return await withTimeout(fn(), timeout); }
      catch { warnings.push(`${label} unavailable. Refresh or open its settings below.`); return fallback; }
    };
    async function loadDirectory(ctx) {
      const warnings = [];
      // These are in-memory Host projections. Publish them before settings,
      // credentials, subscription stores, or model discovery can delay the UI.
      const [live, declared] = await Promise.all([
        attempt(warnings, "Active providers", () => ctx.remote.llm.listProviders().then(unwrap), []),
        attempt(warnings, "Provider directory", () => ctx.remote.llm.listConfigurableProviders().then(unwrap), [])
      ]);
      const rows = declared.map(d => ({
        ...d,
        active: live.some(p => p.id === d.provider),
        authSection: subscriptions.has(d.provider) ? "subscriptions" : "models",
        auth: "unknown"
      }));
      for (const provider of live) if (!rows.some(row => row.provider === provider.id)) rows.push({
        provider:provider.id,
        displayName:provider.name,
        active:true,
        settingsPath:[],
        authSection:subscriptions.has(provider.id) ? "subscriptions" : "models",
        auth:"unknown"
      });
      return {rows, catalog:emptyCatalog(), warnings, authenticationLoaded:false};
    }
    async function loadAuthentication(ctx, facts) {
      const warnings = [];
      const describe = ctx.settingsScope.describe();
      const settings = attempt(warnings, "Settings", async () => {
        await describe.ensure();
        return describe.getSnapshot().view;
      }, undefined);
      const subscriptionStatus = facts.rows.some(row => subscriptions.has(row.provider))
        ? attempt(warnings, "Subscription status", async () => unwrap(await ctx.connection.rpc.call("/api", "subscriptions-auth.status", {})).providers, undefined)
        : Promise.resolve(undefined);
      const [view, auth] = await Promise.all([settings, subscriptionStatus]);
      if (!view) warnings.push("Settings unavailable. Open this app through its authenticated localhost URL to configure providers.");
      const rows = facts.rows.map(row => {
        const ns = view?.namespaces.find(item => item.ns === row.settingsNs);
        const profile = at(ns?.value, row.settingsPath || []);
        const ref = profile?.apiKeyEnv;
        return {
          ...row,
          ref,
          auth: subscriptions.has(row.provider)
            ? auth === undefined ? "unknown" : auth?.[row.provider]?.accounts?.length > 0 ? "stored" : "missing"
            : !view ? "unknown" : ref ? "unknown" : "external"
        };
      });
      const refs = [...new Set(rows.map(row => row.ref).filter(Boolean))];
      const credentials = refs.length
        ? await attempt(warnings, "Credential status", async () => unwrap(await ctx.remote.credentials.describe(refs)), undefined)
        : {};
      for (const row of rows) if (row.ref && !subscriptions.has(row.provider)) {
        row.auth = credentials === undefined ? "unknown" : credentials[row.ref]?.configured === true ? "stored" : "missing";
      }
      return {...facts, rows, warnings:mergeWarnings(facts.warnings, warnings), authenticationLoaded:true};
    }
    async function loadCatalog(ctx, provider) {
      const warnings = [];
      if (!provider) {
        const catalog = await attempt(warnings, "Model catalog", async () => unwrap(await ctx.remote.session.modelCatalog()), emptyCatalog(), 30000);
        return {catalog, warnings};
      }
      const catalog = await attempt(warnings, "Model catalog", async () => unwrap(await ctx.connection.rpc.call("/api", "dsh-rlm/provider-catalog", {provider})), emptyCatalog(), 30000);
      return {catalog, warnings};
    }
    async function loadFacts(ctx) {
      const directory = await loadDirectory(ctx);
      const [authenticated, catalog] = await Promise.all([
        loadAuthentication(ctx, directory),
        loadCatalog(ctx)
      ]);
      return {...authenticated, catalog:catalog.catalog, warnings:mergeWarnings(authenticated.warnings, catalog.warnings)};
    }
    function selectable(facts, provider, model, externalConfirmed) {
      const row = facts?.rows.find(r => r.provider === provider);
      return !!(row?.active && (row.auth === "stored" || row.auth === "external" && externalConfirmed)
        && facts.catalog.groups.some(g => g.id === provider && g.models.some(m => m.id === model)));
    }
    async function saveDefault(ctx, facts, provider, model, externalConfirmed) {
      // Re-read adapter/auth facts before any write: a listed model is not an auth test.
      const directory = await loadDirectory(ctx);
      const authenticated = await loadAuthentication(ctx, directory);
      const catalog = await loadCatalog(ctx, provider);
      const fresh = {...authenticated, catalog:catalog.catalog, warnings:mergeWarnings(authenticated.warnings, catalog.warnings)};
      if (!selectable(fresh, provider, model, externalConfirmed)) throw new Error("Provider is not configured");
      const scope = ctx.settingsScope.bind({ namespace: "agent-default-model" });
      const before = scope.getSnapshot();
      if (before.status !== "ready" || !before.writable) throw new Error("Default model is read-only");
      await scope.mutate([
        { op:"set", path:["provider"], value:provider },
        { op:"set", path:["model"], value:model },
        { op:"unset", path:["reasoningEffort"] }
      ], before.revision);
      const after = scope.getSnapshot();
      if (after.status !== "ready" || after.value?.provider !== provider || after.value?.model !== model || after.value?.reasoningEffort !== undefined)
        throw new Error("Default model write was not confirmed");
    }
    function Setup({ ctx, complete, openSection }) {
      const [facts, setFacts] = React.useState(null);
      const [provider, setProvider] = React.useState("");
      const [model, setModel] = React.useState("");
      const [external, setExternal] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [catalogBusy, setCatalogBusy] = React.useState(false);
      const [message, setMessage] = React.useState("");
      const [saved, setSaved] = React.useState(false);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      const catalogGeneration = React.useRef(0);
      const publishIfCurrent = (g, update) => {
        if (!alive.current || g !== generation.current) return false;
        setFacts(current => update(current));
        return true;
      };
      const enrichAuthentication = async (g, directory) => {
        const authenticated = await loadAuthentication(ctx, directory);
        if (publishIfCurrent(g, current => current ? {...authenticated, catalog:current.catalog} : authenticated)) {
          const savedDefault = ctx.settingsScope.bind({namespace:"agent-default-model"}).getSnapshot().user;
          if (complete && savedDefault?.provider && savedDefault?.model) {
            // Completion is security-sensitive: re-read the catalog/auth facts,
            // but never hold the provider directory behind this validation.
            const catalog = await loadCatalog(ctx, savedDefault.provider);
            const checked = {...authenticated, catalog:catalog.catalog, warnings:mergeWarnings(authenticated.warnings, catalog.warnings)};
            if (alive.current && g === generation.current && selectable(checked, savedDefault.provider, savedDefault.model, false)) complete();
          }
        }
      };
      const refresh = async () => {
        const g = ++generation.current;
        ++catalogGeneration.current;
        setBusy(true); setCatalogBusy(false); setMessage(""); setSaved(false);
        try {
          const directory = await loadDirectory(ctx);
          if (publishIfCurrent(g, () => directory)) {
            setBusy(false);
            if (provider) void requestCatalog(provider);
            void enrichAuthentication(g, directory).catch(() => {
              if (alive.current && g === generation.current) setMessage("Authentication state is still loading. Provider navigation remains available; retry before saving a default.");
            });
          }
        }
        catch { if (alive.current && g === generation.current) { setMessage("Setup could not refresh the local provider directory. Open Models or Subscriptions below, then return and retry."); } }
        finally { if (alive.current && g === generation.current) setBusy(false); }
      };
      const requestCatalog = async selected => {
        const g = ++catalogGeneration.current;
        if (!selected) { setCatalogBusy(false); return; }
        setCatalogBusy(true);
        try {
          const result = await loadCatalog(ctx, selected);
          if (alive.current && g === catalogGeneration.current) setFacts(current => current && ({
            ...current,
            catalog:result.catalog,
            warnings:mergeWarnings(current.warnings, result.warnings)
          }));
        } finally { if (alive.current && g === catalogGeneration.current) setCatalogBusy(false); }
      };
      React.useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; ++generation.current; ++catalogGeneration.current; }; }, [ctx]);
      const row = facts?.rows.find(r => r.provider === provider);
      const models = facts?.catalog.groups.find(g => g.id === provider)?.models || [];
      const changeProvider = e => {
        const selected = e.target.value;
        setProvider(selected); setModel(""); setExternal(false); setSaved(false); setMessage("");
        setFacts(current => current && ({...current,catalog:emptyCatalog()}));
        void requestCatalog(selected);
      };
      const save = async () => {
        setBusy(true); setSaved(false); setMessage("");
        try { await saveDefault(ctx, facts, provider, model, external); if (alive.current) { setSaved(true); setMessage("Default model saved and read back. No inference request was made; credentials and model access are not network-tested."); } }
        catch { if (alive.current) setMessage("Default model was not confirmed. Refresh state before retrying; check authentication and writable settings."); }
        finally { if (alive.current) setBusy(false); }
      };
      const button = (label, onClick, disabled=false) => h("button", {type:"button", onClick, disabled, style:{padding:"8px 12px", marginRight:8}}, label);
      return h("section", {style:{padding:24, maxWidth:660, display:"grid", gap:16}},
        h("h2", null, "Set up dsh-rlm"),
        h("p", null, "Connect your preferred provider, then choose a default model. You can use an API key or a supported subscription account."),
        openSection && h("div", null,
          button("Connect a subscription", () => { complete?.(); openSection("subscriptions"); }),
          button("Set up an API provider", () => { complete?.(); openSection("models"); })),
        (facts?.warnings || []).map(w => h("p", {key:w,role:"status"}, w)),
        h("label", null, "1. Provider", h("select", {value:provider, onChange:changeProvider, disabled:busy, style:{display:"block",width:"100%",padding:8}},
          h("option", {value:""}, busy && !facts ? "Loading local providers…" : "Choose a provider"), ...(facts?.rows || []).map(r => h("option", {key:r.provider,value:r.provider}, `${r.displayName} (${r.provider})${r.active ? "" : " — adapter inactive"}`)))),
        facts && !facts.rows.length && h("p", {role:"alert"}, "No providers could be listed yet. Open Subscriptions or Models above to configure a provider, then return to Setup and refresh."),
        row && h("div", null,
          h("h3", null, "2. Authentication"),
          h("p", null, row.auth === "stored" ? "Host reports stored credentials/account. This does not prove current authorization or quota." : ["missing","unknown"].includes(row.auth) ? "Authentication is missing or unavailable. Configure it using the adapter-owned settings." : "This adapter uses its own authentication (for example ADC, environment, or a local endpoint). Setup cannot verify it."),
          h("p", null, `Use Settings → ${row.authSection === "subscriptions" ? "Subscriptions" : "Models"}, configure ${row.displayName}, then return to Settings → Setup and refresh. Only the adapter's own supported authentication methods are offered there.`),
          openSection && button("Open authentication settings", () => { complete?.(); openSection(row.authSection); }, busy),
          row.auth === "external" && h("label", null, h("input", {type:"checkbox",checked:external,disabled:busy,onChange:e=>{setExternal(e.target.checked);setSaved(false);}}), " I configured this adapter's external authentication (not verified).")),
        h("label", null, "3. Default model", h("select", {value:model, disabled:busy || !row?.active, onChange:e=>{setModel(e.target.value);setSaved(false);}, style:{display:"block",width:"100%",padding:8}},
          h("option", {value:""}, catalogBusy ? "Loading models for this provider…" : "Choose an advertised model"), ...models.map(m=>h("option",{key:m.id,value:m.id},m.name || m.id)))),
        row && catalogBusy && h("p", {role:"status"}, "Loading models for the selected provider. Provider navigation and authentication settings remain available."),
        row && !catalogBusy && !models.length && h("p", null, "No model catalog available for this route. Authenticate/configure the adapter and refresh; setup is not complete."),
        h("p", null, "Catalogs are advisory and may be cached. Saving affects future agents, not existing sessions. Use Models settings for custom model IDs."),
        h("div", null, button(busy ? "Loading providers…" : "Refresh provider state", refresh, busy), button("Save default model", save, busy || catalogBusy || !selectable(facts,provider,model,external))),
        message && h("p", {role:"status"}, message),
        complete && button(saved ? "Continue" : "Configure later (not complete)", complete, busy));
    }
    function Onboarding(props) {
      React.useEffect(() => {
        const root = document.getElementById("root");
        if (!root) return;
        const previous = root.inert; root.inert = true;
        return () => { root.inert = previous; };
      }, []);
      return h(Modal, {open:true, title:"Set up dsh-rlm", onClose:()=>{}, headless:true}, h(Setup,props));
    }
    function apply(ctx) {
      const inject = () => ({ctx});
      ctx.slots.inject("settings.onboarding", () => ctx.slots.register({name:"settings.onboarding", id:"deepseek-official", priority:-100, order:0, inject}, Onboarding));
      ctx.slots.inject("settings.section", () => ctx.slots.register({name:"settings.section", id:"dsh-rlm-setup", order:5, label:()=>"Setup", inject}, Setup));
    }
    return { apply, inject:["slots","remote","remote.llm","remote.session","remote.credentials","settingsScope","connection"], loadDirectory, loadAuthentication, loadCatalog, loadFacts, selectable, saveDefault };
  }
});
