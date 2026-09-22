window.__ModuleLoader__.load({
  id: "@dsh-rlm/jev-settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    const NS = "settings.jev";
    const SETTINGS_NAMESPACE = "jev";
    const STATUS_ENDPOINT = "jev/status";
    const TEST_ENDPOINT = "jev/testConnection";
    const CREDENTIAL_REF = "TYPESAFE_API_KEY";
    const DEFAULTS = {
      enabled: true,
      apiKeyEnv: CREDENTIAL_REF,
      model: "jev-latest",
      timeoutMs: 10000,
      baseURL: "https://api.typesafe.ai"
    };

    const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    const text = (value) => typeof value === "string" ? value : "";
    const safeMessage = (fallback) => fallback;

    function parseStatus(value) {
      if (!isRecord(value)) return null;
      const state = value.state;
      if (state !== "disabled" && state !== "not-configured" && state !== "configured") return null;
      if (!(value.credentialSource === null || typeof value.credentialSource === "string")) return null;
      if (typeof value.model !== "string" || typeof value.baseURL !== "string") return null;
      return { state, credentialSource: value.credentialSource, model: value.model, baseURL: value.baseURL };
    }
    function parseTest(value) {
      if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.code !== "string" || typeof value.message !== "string") return null;
      return { ok: value.ok, code: value.code, message: value.ok ? value.message : safeMessage("Connection test failed. Check the credential, endpoint, and network.") };
    }
    function parseCredential(value, ref) {
      if (!isRecord(value) || !isRecord(value[ref])) return { configured: false, writable: false };
      const item = value[ref];
      return { configured: item.configured === true, writable: item.writable === true };
    }
    function normalizeSettings(value) {
      if (!isRecord(value)) return { ...DEFAULTS };
      return {
        enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
        apiKeyEnv: typeof value.apiKeyEnv === "string" && value.apiKeyEnv.length > 0 ? value.apiKeyEnv : DEFAULTS.apiKeyEnv,
        model: typeof value.model === "string" ? value.model : DEFAULTS.model,
        timeoutMs: typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? value.timeoutMs : DEFAULTS.timeoutMs,
        baseURL: typeof value.baseURL === "string" ? value.baseURL : DEFAULTS.baseURL
      };
    }
    function validRef(value) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
    function validEndpoint(value) {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && (url.pathname === "" || url.pathname === "/");
      } catch { return false; }
    }

    class JevController {
      constructor(ctx) {
        this.ctx = ctx;
        this.scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
        this.connection = ctx.connection;
        this.disposed = false;
        this.statusGeneration = 0;
        this.statusAbort = null;
        this.credentialGeneration = 0;
        this.credentialAbort = null;
        this.testAbort = null;
        this.saving = false;
        this.secretSaving = false;
        this.testRunning = false;
        this.failed = false;
        this.secretFailed = false;
        this.testResult = null;
        this.status = null;
        this.statusState = "idle";
        this.credential = { ref: CREDENTIAL_REF, configured: false, writable: false, loading: true };
        this.draft = null;
        this.store = createSnapshotStore(this.projection());
        this.lastStored = this.stored();
        this.offScope = this.scope.subscribe(() => {
          const wasClean = this.draft === null || Object.keys(this.lastStored).every(key => this.current()[key] === this.lastStored[key]);
          this.lastStored = this.stored();
          if (wasClean) this.draft = { ...this.lastStored };
          this.testResult = null;
          this.testAbort?.abort();
          this.readStatus();
          const ref = this.current().apiKeyEnv;
          if (ref !== this.credential.ref) this.readCredential();
          this.publish();
        });
        this.draft = normalizeSettings(this.scope.getSnapshot().value);
        this.publish();
      }
      current() { return this.draft ?? normalizeSettings(this.scope.getSnapshot().value); }
      stored() { return normalizeSettings(this.scope.getSnapshot().value); }
      isDirty() {
        const a = this.current(), b = this.stored();
        return a.enabled !== b.enabled || a.apiKeyEnv !== b.apiKeyEnv || a.model !== b.model || a.timeoutMs !== b.timeoutMs || a.baseURL !== b.baseURL;
      }
      projection() {
        const snapshot = this.scope.getSnapshot();
        const settings = this.current();
        const timeoutText = String(settings.timeoutMs);
        const refChanged = settings.apiKeyEnv !== this.credential.ref;
        return {
          available: snapshot.status === "ready",
          writable: snapshot.writable === true,
          enabled: settings.enabled,
          apiKeyEnv: settings.apiKeyEnv,
          model: settings.model,
          timeoutMs: timeoutText,
          baseURL: settings.baseURL,
          dirty: this.isDirty(),
          saving: this.saving,
          failed: this.failed,
          secretConfigured: this.credential.configured,
          secretSaving: this.secretSaving,
          secretFailed: this.secretFailed,
          credential: refChanged ? { ref: settings.apiKeyEnv, configured: false, writable: false, loading: true } : this.credential,
          status: this.status,
          statusState: this.statusState,
          testRunning: this.testRunning,
          testResult: this.testResult,
          canTest: snapshot.status === "ready" && !this.isDirty() && settings.enabled && !refChanged && this.statusState === "ready" && this.status?.state === "configured" && !this.saving && !this.secretSaving && !this.testRunning,
          error: snapshot.status === "error" ? "Jev settings are unavailable." : null
        };
      }
      publish() { if (!this.disposed) this.store.set(this.projection()); }
      edit(field, value) {
        if (this.disposed || this.saving || this.secretSaving || this.testRunning || !this.scope.getSnapshot().writable) return;
        const next = { ...this.current(), [field]: value };
        if (field === "enabled") next.enabled = Boolean(value);
        this.draft = next;
        this.failed = false;
        this.testResult = null;
        this.testAbort?.abort();
        this.publish();
      }
      toggleEnabled() { this.edit("enabled", !this.current().enabled); }
      discard() {
        if (this.saving) return;
        this.draft = this.stored();
        this.failed = false;
        this.secretDraft = "";
        this.secretFailed = false;
        this.publish();
        this.readCredential();
      }
      async save() {
        const snapshot = this.scope.getSnapshot(), value = this.current();
        if (this.disposed || this.saving || !snapshot.writable || snapshot.status !== "ready" || !this.isDirty()) return;
        const timeout = Number(value.timeoutMs);
        if (!validRef(value.apiKeyEnv) || !value.model.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 120000 || !validEndpoint(value.baseURL)) {
          this.failed = true; this.publish(); return;
        }
        const revision = snapshot.revision;
        this.saving = true; this.failed = false; this.publish();
        try {
          await this.scope.mutate([
            { op: "set", path: ["enabled"], value: value.enabled },
            { op: "set", path: ["apiKeyEnv"], value: value.apiKeyEnv },
            { op: "set", path: ["model"], value: value.model.trim() },
            { op: "set", path: ["timeoutMs"], value: timeout },
            { op: "set", path: ["baseURL"], value: value.baseURL }
          ], revision);
          const intended = { ...value, model: value.model.trim(), timeoutMs: timeout };
          const stored = this.stored();
          this.failed = Object.keys(intended).some(key => intended[key] !== stored[key]);
          if (!this.failed) this.draft = stored;
          await this.readStatus();
        } catch {
          this.failed = true;
        } finally {
          this.saving = false;
          this.publish();
        }
      }
      async readStatus() {
        if (this.disposed) return;
        const generation = ++this.statusGeneration;
        this.statusAbort?.abort();
        const abort = new AbortController(); this.statusAbort = abort;
        this.statusState = "loading"; this.publish();
        try {
          const response = await this.connection.rpc.call("/api", STATUS_ENDPOINT, { args: {} }, abort.signal);
          if (generation !== this.statusGeneration || this.disposed) return;
          const result = response?.ok === true ? parseStatus(response.value) : null;
          this.status = result;
          this.statusState = result === null ? "error" : "ready";
        } catch {
          if (generation !== this.statusGeneration || this.disposed) return;
          this.status = null; this.statusState = "error";
        } finally {
          if (generation === this.statusGeneration) this.publish();
        }
      }
      async readCredential() {
        if (this.disposed) return;
        const ref = this.current().apiKeyEnv;
        const generation = ++this.credentialGeneration;
        this.credentialAbort?.abort();
        const abort = new AbortController(); this.credentialAbort = abort;
        this.credential = { ref, configured: false, writable: false, loading: true }; this.publish();
        try {
          const response = await this.ctx.remote.credentials.describe([ref]);
          if (generation !== this.credentialGeneration || this.disposed || ref !== this.current().apiKeyEnv) return;
          this.credential = response?.ok === true ? { ref, ...parseCredential(response.value, ref), loading: false } : { ref, configured: false, writable: false, loading: false };
        } catch {
          if (generation !== this.credentialGeneration || this.disposed) return;
          this.credential = { ref, configured: false, writable: false, loading: false };
        } finally {
          if (generation === this.credentialGeneration) this.publish();
        }
      }
      async saveSecret(value) {
        const ref = this.current().apiKeyEnv, secret = typeof value === "string" ? value.trim() : "";
        if (this.disposed || this.secretSaving || !secret || this.isDirty() || this.credential.loading || !this.credential.writable) return false;
        this.secretSaving = true; this.secretFailed = false; this.testResult = null; this.publish();
        try {
          const response = await this.ctx.remote.credentials.set(ref, secret);
          if (!response?.ok) throw new Error("credential write failed");
          await this.readCredential(); await this.readStatus(); return true;
        } catch { this.secretFailed = true; return false; }
        finally { this.secretSaving = false; this.publish(); }
      }
      async removeSecret() {
        const ref = this.current().apiKeyEnv;
        if (this.disposed || this.secretSaving || this.isDirty() || this.credential.loading || !this.credential.writable || !this.credential.configured) return;
        this.secretSaving = true; this.secretFailed = false; this.publish();
        try {
          const response = await this.ctx.remote.credentials.unset(ref);
          if (!response?.ok) throw new Error("credential removal failed");
          await this.readCredential(); await this.readStatus();
        } catch { this.secretFailed = true; }
        finally { this.secretSaving = false; this.publish(); }
      }
      async testConnection() {
        if (!this.projection().canTest) return;
        this.testRunning = true; this.testResult = null; this.testAbort?.abort();
        const abort = new AbortController(); this.testAbort = abort; this.publish();
        try {
          const response = await this.connection.rpc.call("/api", TEST_ENDPOINT, { args: {} }, abort.signal);
          if (abort.signal.aborted || this.disposed) return;
          if (response?.ok === true) {
            const result = parseTest(response.value);
            this.testResult = result ?? { ok: false, code: "INVALID_RESPONSE", message: safeMessage("Connection test failed. Check the credential, endpoint, and network.") };
          } else this.testResult = { ok: false, code: "UNAVAILABLE", message: safeMessage("Connection test failed. Check the credential, endpoint, and network.") };
        } catch { if (abort.signal.aborted || this.disposed) return; this.testResult = { ok: false, code: "UNAVAILABLE", message: safeMessage("Connection test failed. Check the credential, endpoint, and network.") }; }
        finally { this.testRunning = false; this.publish(); }
      }
      inject() {
        if (this.face) return this.face;
        return this.face = {
          hooks: { jev: this.store },
          edit: (field, value) => this.edit(field, value),
          toggleEnabled: () => this.toggleEnabled(),
          save: () => this.save(),
          discard: () => this.discard(),
          refreshStatus: () => this.readStatus(),
          refreshCredential: () => this.readCredential(),
          saveSecret: (value) => this.saveSecret(value),
          removeSecret: () => this.removeSecret(),
          testConnection: () => this.testConnection()
        };
      }
      dispose() {
        this.disposed = true; this.statusGeneration++; this.credentialGeneration++;
        this.statusAbort?.abort(); this.credentialAbort?.abort(); this.testAbort?.abort(); this.offScope?.();
      }
    }

    const h = (type, props, ...children) => React.createElement(type, props, ...children);
    const css = `.dsh-jev-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}.dsh-jev-title{margin:0;font-size:18px;font-weight:600}.dsh-jev-intro,.dsh-jev-hint,.dsh-jev-status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}.dsh-jev-advanced{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}.dsh-jev-advanced summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px}.dsh-jev-card{border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:12px}.dsh-jev-row{display:flex;align-items:center;gap:10px}.dsh-jev-row label,.dsh-jev-field label{font-size:13px;font-weight:500}.dsh-jev-row label{flex:1}.dsh-jev-field{display:flex;flex-direction:column;gap:6px}.dsh-jev-input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);height:34px;border-radius:8px;padding:0 10px;font:inherit;font-size:13px}.dsh-jev-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.dsh-jev-input:disabled{color:var(--dsw-alias-label-tertiary)}.dsh-jev-switch{appearance:none;width:38px;height:22px;border-radius:12px;background:var(--dsw-alias-border-l3);position:relative;cursor:pointer}.dsh-jev-switch:after{content:"";position:absolute;width:18px;height:18px;top:2px;left:2px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .12s}.dsh-jev-switch[data-on=true]{background:var(--dsw-alias-brand-primary)}.dsh-jev-switch[data-on=true]:after{transform:translateX(16px)}.dsh-jev-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-jev-primary,.dsh-jev-secondary{font:inherit;font-size:13px;border-radius:8px;padding:6px 13px;cursor:pointer}.dsh-jev-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:1px solid transparent}.dsh-jev-secondary{color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l3)}.dsh-jev-actions button:disabled{opacity:.45;cursor:default}.dsh-jev-error{color:var(--dsw-alias-error-primary,#c33)}.dsh-jev-success{color:var(--dsw-alias-success-primary,#287)}.dsh-jev-badge{font-size:12px;margin-left:8px}`;
    function installCss() {
      if (typeof document === "undefined" || document.querySelector("style[data-plugin-css='dsh-jev-settings']")) return;
      const tag = document.createElement("style"); tag.dataset.plugin = "@dsh-rlm/jev-settings"; tag.dataset.pluginCss = "dsh-jev-settings"; tag.textContent = css; document.head.appendChild(tag);
    }
    function statusCopy(state) {
      if (state === "configured") return "Configured";
      if (state === "disabled") return "Disabled";
      if (state === "not-configured") return "Not configured";
      return "Unavailable";
    }
    function JevSection(props) {
      installCss();
      const state = props.useJev((value) => value);
      const [secret, setSecret] = React.useState("");
      const secretRef = React.useRef("");
      React.useEffect(() => { secretRef.current = ""; setSecret(""); }, [state.apiKeyEnv]);
      const disabled = !state.writable || !state.available;
      React.useEffect(() => { props.refreshStatus(); props.refreshCredential(); return () => { secretRef.current = ""; }; }, [props.refreshStatus, props.refreshCredential]);
      const field = (label, key, type, hint) => h("div", { className: "dsh-jev-field" }, h("label", { htmlFor: `jev-${key}` }, label), h("input", { id: `jev-${key}`, className: "dsh-jev-input", type, value: state[key], disabled, onChange: (event) => props.edit(key, event.target.value) }), hint ? h("p", { className: "dsh-jev-hint" }, hint) : null);
      const statusText = state.statusState === "loading" ? "Loading status…" : state.status ? `${statusCopy(state.status.state)}${state.status.credentialSource ? ` · ${state.status.credentialSource}` : ""}` : "Unavailable";
      const testMessage = state.testResult ? h("p", { className: state.testResult.ok ? "dsh-jev-success" : "dsh-jev-error", role: "status" }, state.testResult.ok ? "Connection verified." : state.testResult.message) : null;
      return h("section", { className: "dsh-jev-section", "aria-label": "Jev Judge" },
        h("h2", { className: "dsh-jev-title" }, "Jev Judge"),
        h("p", { className: "dsh-jev-intro" }, "Configure optional Jev structured judging for this deployment. Test connection sends only a fixed greeting sample and may incur a small charge; it never sends your conversation."),
        h("div", { className: "dsh-jev-card" },
          h("div", { className: "dsh-jev-row" }, h("label", { htmlFor: "jev-enabled" }, "Enabled"), h("button", { id: "jev-enabled", type: "button", role: "switch", "aria-checked": state.enabled, "data-on": state.enabled, className: "dsh-jev-switch", disabled, onClick: props.toggleEnabled }, h("span", { "aria-hidden": true }))),
          h("p", { className: "dsh-jev-status", role: "status" }, `Status: ${statusText}`),
          field("API key environment reference", "apiKeyEnv", "text", "Reference only; the secret is stored outside settings."),
          field("Model", "model", "text", "Default: jev-latest."),
          field("Timeout (ms)", "timeoutMs", "number", "Between 1 and 120000 milliseconds."),
          h("details", { className: "dsh-jev-advanced" }, h("summary", null, "Advanced endpoint"), field("Endpoint root", "baseURL", "url", "HTTPS root only. Jev receives your key and explicit state at this endpoint.")),
          h("div", { className: "dsh-jev-actions" }, h("button", { className: "dsh-jev-primary", type: "button", disabled: disabled || !state.dirty || state.saving, onClick: props.save }, state.saving ? "Saving…" : "Save"), h("button", { className: "dsh-jev-secondary", type: "button", disabled: !state.dirty || state.saving, onClick: props.discard }, "Discard"), state.failed ? h("p", { className: "dsh-jev-error", role: "alert" }, "These values were not accepted. Check the fields and try again.") : null),
          h("div", { className: "dsh-jev-field" }, h("label", { htmlFor: "jev-secret" }, "API key", h("span", { className: "dsh-jev-badge" }, state.credential.configured ? "Configured" : "Not configured")), h("input", { id: "jev-secret", className: "dsh-jev-input", type: "password", autoComplete: "off", value: secret, disabled: disabled || state.secretSaving || state.credential.loading || state.dirty || !state.credential.writable, placeholder: state.credential.configured ? "Leave blank to keep current key" : "Enter API key", onChange: (event) => { secretRef.current = event.target.value; setSecret(event.target.value); } }), h("p", { className: "dsh-jev-hint" }, "Write-only; never returned or stored in settings."), h("div", { className: "dsh-jev-actions" }, h("button", { className: "dsh-jev-primary", type: "button", disabled: disabled || !secret.trim() || state.secretSaving || state.credential.loading || state.dirty || !state.credential.writable, onClick: async () => { try { await props.saveSecret(secret); } finally { secretRef.current = ""; setSecret(""); } } }, state.secretSaving ? "Saving…" : "Save secret"), h("button", { className: "dsh-jev-secondary", type: "button", disabled: disabled || state.dirty || state.credential.loading || !state.credential.configured || state.secretSaving || !state.credential.writable, onClick: props.removeSecret }, "Remove secret"), state.secretFailed ? h("p", { className: "dsh-jev-error", role: "alert" }, "The secret operation failed.") : null)),
          h("div", { className: "dsh-jev-actions" }, h("button", { className: "dsh-jev-secondary", type: "button", disabled: !state.canTest || secret.trim().length > 0, onClick: props.testConnection }, state.testRunning ? "Testing…" : "Test connection"), testMessage)
        )
      );
    }
    const en = { nav: "Jev Judge" };
    const zh = { nav: "Jev Judge" };
    const inject = ["slots", "locale", "connection", "remote", "remote.credentials", "settingsScope"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "jev-settings: dictionaries");
      const t = ctx.locale.bind(NS);
      const controller = new JevController(ctx);
      ctx.effect(() => () => controller.dispose(), "jev-settings: dispose controller");
      ctx.slots.inject("settings.section", () => {
        let off;
        const sync = () => {
          const ready = controller.scope.getSnapshot().status === "ready";
          if (ready && !off) off = ctx.slots.register({
            name: "settings.section", id: "jev", order: 25, label: () => t("nav"), locale: NS, inject: () => controller.inject()
          }, JevSection);
          if (!ready && off) { off(); off = undefined; }
        };
        sync();
        const unsubscribe = controller.scope.subscribe(sync);
        return () => { unsubscribe(); off?.(); };
      });
      ctx.on("credentials/reference-updated", () => { controller.readCredential(); controller.readStatus(); });
      ctx.on("connection/reset", () => { controller.testAbort?.abort(); controller.testResult = null; controller.readCredential(); controller.readStatus(); });
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.JevController = JevController;
    return module.exports;
  }
});
