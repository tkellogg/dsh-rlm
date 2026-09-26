window.__ModuleLoader__.load({
  id: "@dsh-rlm/onboarding",
  factory: (require) => {
    const React = require("react");
    const { Modal } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const subscriptions = new Set(["codex", "claude", "grok", "copilot", "antigravity"]);
    const unwrap = r => { if (!r?.ok) throw new Error("Host request failed"); return r.value; };
    const at = (value, path) => path.reduce((v, key) => v?.[key], value);
    async function loadFacts(ctx) {
      const describe = ctx.settingsScope.describe();
      const warnings = [];
      // Independent capabilities: a catalog/auth failure must not erase the directory.
      const attempt = async (label, fn, fallback) => {
        try { return await fn(); }
        catch { warnings.push(`${label} unavailable. Refresh or open its settings below.`); return fallback; }
      };
      const [live, declared, catalog] = await Promise.all([
        attempt("Active providers", () => ctx.remote.llm.listProviders().then(unwrap), []),
        attempt("Provider directory", () => ctx.remote.llm.listConfigurableProviders().then(unwrap), []),
        attempt("Model catalog", () => ctx.remote.session.modelCatalog().then(unwrap), {groups:[],failures:[]}),
        attempt("Settings", () => describe.ensure(), undefined)
      ]);
      const view = describe.getSnapshot().view;
      if (!view) warnings.push("Settings unavailable. Open this app through its authenticated localhost URL to configure providers.");
      const rows = declared.map(d => ({ ...d, active: live.some(p => p.id === d.provider) }));
      for (const p of live) if (!rows.some(r => r.provider === p.id)) rows.push({provider:p.id, displayName:p.name, active:true, settingsPath:[]});
      let auth = null;
      if (rows.some(r => subscriptions.has(r.provider))) {
        try { auth = unwrap(await ctx.connection.rpc.call("/api", "subscriptions-auth.status", {})).providers; } catch { /* absent adapter or status unavailable is not authenticated */ }
      }
      for (const row of rows) {
        const ns = view?.namespaces.find(n => n.ns === row.settingsNs);
        const profile = at(ns?.value, row.settingsPath || []);
        row.ref = profile?.apiKeyEnv;
        row.authSection = subscriptions.has(row.provider) ? "subscriptions" : "models";
        row.auth = subscriptions.has(row.provider)
          ? (auth?.[row.provider]?.accounts?.length > 0 ? "stored" : "missing")
          : !view ? "unknown" : row.ref ? "missing" : "external";
      }
      const refs = [...new Set(rows.map(r => r.ref).filter(Boolean))];
      const credentials = refs.length ? await attempt("Credential status", async () => unwrap(await ctx.remote.credentials.describe(refs)), {}) : {};
      for (const row of rows) if (row.ref && !subscriptions.has(row.provider)) row.auth = credentials[row.ref]?.configured === true ? "stored" : "missing";
      return { rows, catalog, warnings };
    }
    function selectable(facts, provider, model, externalConfirmed) {
      const row = facts?.rows.find(r => r.provider === provider);
      return !!(row?.active && (row.auth === "stored" || row.auth === "external" && externalConfirmed)
        && facts.catalog.groups.some(g => g.id === provider && g.models.some(m => m.id === model)));
    }
    async function saveDefault(ctx, facts, provider, model, externalConfirmed) {
      // Re-read adapter/auth facts before any write: a listed model is not an auth test.
      const fresh = await loadFacts(ctx);
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
      const [message, setMessage] = React.useState("");
      const [saved, setSaved] = React.useState(false);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      const refresh = async () => {
        const g = ++generation.current;
        setBusy(true); setMessage(""); setSaved(false);
        try {
          const next = await loadFacts(ctx);
          if (alive.current && g === generation.current) {
            setFacts(next);
            const savedDefault = ctx.settingsScope.bind({namespace:"agent-default-model"}).getSnapshot().user;
            if (complete && savedDefault?.provider && savedDefault?.model && selectable(next, savedDefault.provider, savedDefault.model, false)) complete();
          }
        }
        catch { if (alive.current && g === generation.current) { setMessage("Setup could not refresh. Open Models or Subscriptions below to connect your provider, then return and retry."); } }
        finally { if (alive.current && g === generation.current) setBusy(false); }
      };
      React.useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; ++generation.current; }; }, [ctx]);
      const row = facts?.rows.find(r => r.provider === provider);
      const models = facts?.catalog.groups.find(g => g.id === provider)?.models || [];
      const changeProvider = e => { setProvider(e.target.value); setModel(""); setExternal(false); setSaved(false); setMessage(""); };
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
          h("option", {value:""}, "Choose a provider"), ...(facts?.rows || []).map(r => h("option", {key:r.provider,value:r.provider}, `${r.displayName} (${r.provider})${r.active ? "" : " — adapter inactive"}`)))),
        facts && !facts.rows.length && h("p", {role:"alert"}, "No providers could be listed yet. Open Subscriptions or Models above to configure a provider, then return to Setup and refresh."),
        row && h("div", null,
          h("h3", null, "2. Authentication"),
          h("p", null, row.auth === "stored" ? "Host reports stored credentials/account. This does not prove current authorization or quota." : ["missing","unknown"].includes(row.auth) ? "Authentication is missing or unavailable. Configure it using the adapter-owned settings." : "This adapter uses its own authentication (for example ADC, environment, or a local endpoint). Setup cannot verify it."),
          h("p", null, `Use Settings → ${row.authSection === "subscriptions" ? "Subscriptions" : "Models"}, configure ${row.displayName}, then return to Settings → Setup and refresh. Only the adapter's own supported authentication methods are offered there.`),
          openSection && button("Open authentication settings", () => { complete?.(); openSection(row.authSection); }, busy),
          row.auth === "external" && h("label", null, h("input", {type:"checkbox",checked:external,disabled:busy,onChange:e=>{setExternal(e.target.checked);setSaved(false);}}), " I configured this adapter's external authentication (not verified).")),
        h("label", null, "3. Default model", h("select", {value:model, disabled:busy || !row?.active, onChange:e=>{setModel(e.target.value);setSaved(false);}, style:{display:"block",width:"100%",padding:8}},
          h("option", {value:""}, "Choose an advertised model"), ...models.map(m=>h("option",{key:m.id,value:m.id},m.name || m.id)))),
        row && !models.length && h("p", null, "No model catalog available for this route. Authenticate/configure the adapter and refresh; setup is not complete."),
        h("p", null, "Catalogs are advisory and may be cached. Saving affects future agents, not existing sessions. Use Models settings for custom model IDs."),
        h("div", null, button(busy ? "Working…" : "Refresh provider state", refresh, busy), button("Save default model", save, busy || !selectable(facts,provider,model,external))),
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
    return { apply, inject:["slots","remote","remote.llm","remote.session","remote.credentials","settingsScope","connection"], loadFacts, selectable, saveDefault };
  }
});
