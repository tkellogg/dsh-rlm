/** Host-local onboarding projections that are safe to publish before browser launch. */
const ok = value => ({ok:true,value});
const fail = () => ({ok:false,error:{
  code:"onboarding/provider-catalog-failed",
  message:"Provider model catalog unavailable",
  details:{}
}});
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_ENVELOPE_BYTES = 4096;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
function readProvider(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => key !== "provider")) {
    throw new Error("invalid payload");
  }
  const provider = payload.provider;
  if (typeof provider !== "string" || provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID.test(provider)) {
    throw new Error("invalid provider");
  }
  return provider;
}
async function providerCatalog(ctx, provider, signal) {
  signal?.throwIfAborted();
  const available = ctx.llm.listProviders();
  const route = available.find(item => item.id === provider);
  if (!route) throw new Error(`provider ${JSON.stringify(provider)} is not active`);
  const models = await ctx.llm.listModels(provider);
  signal?.throwIfAborted();
  const entries = [];
  // Resolve serially so abort prevents unscheduled adapter/network work.
  for (const model of models) {
    signal?.throwIfAborted();
    const resolved = await ctx.llm.resolveModelInfo(provider, model.id, signal);
    const reasoning = resolved.reasoning === undefined ? undefined : {
      efforts:resolved.reasoning.efforts.map(effort => ({
        id:effort.id,
        name:effort.name,
        ...(effort.description === undefined ? {} : {description:effort.description})
      })),
      ...(resolved.reasoning.defaultEffort === undefined ? {} : {defaultEffort:resolved.reasoning.defaultEffort})
    };
    entries.push({
      id:model.id,
      name:model.name,
      ...(model.description === undefined ? {} : {description:model.description}),
      ...(reasoning === undefined ? {} : {reasoning})
    });
  }
  return {
    default:{...ctx.agentDefaultModel.currentSelection()},
    routableProviders:available.map(item => item.id),
    groups:entries.length ? [{id:route.id,name:route.name,models:entries}] : [],
    failures:[]
  };
}
export const name = '@dsh-rlm/onboarding';
export const inject = ["connection","llm","agentDefaultModel"];
export async function apply(ctx) {
  // Route registration is synchronous, so loader.await() does not announce/open
  // the browser before it exists. Model work begins only on an authenticated call.
  ctx.connection.fetch.register({
    path:"/api/dsh-rlm/provider-catalog",
    methods:["POST"],
    requestBody:"buffered",
    async fetch(request) {
      if (request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json",{status:415});
      }
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ENVELOPE_BYTES) return new Response("request too large",{status:413});
      let text;
      try { text = await request.text(); }
      catch { return new Response("body unavailable",{status:400}); }
      if (new TextEncoder().encode(text).byteLength > MAX_ENVELOPE_BYTES) return new Response("request too large",{status:413});
      let envelope;
      try { envelope = JSON.parse(text); }
      catch { return new Response("body is not JSON",{status:400}); }
      if (!envelope || envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || envelope.method !== "dsh-rlm/provider-catalog") {
        return new Response("invalid client request",{status:400});
      }
      let result;
      try { result = ok(await providerCatalog(ctx,readProvider(envelope.payload),request.signal)); }
      catch (error) { result = fail(error); }
      return Response.json({type:"server-response",rpcId:envelope.rpcId,result});
    }
  });
}
export { providerCatalog };
