import asyncio
import pytest
from dsh_rlm import UnsupportedOperationError
from dsh_rlm.runtime import Runtime
from dsh_rlm.host_workers import HostWorkerError, HostWorkerLease

class FakeTransport:
    def __init__(self): self.calls=[]; self.released=[]
    async def admit(self,parent,run,worker,lifetime):
        self.calls.append((parent,run,worker,lifetime)); return HostWorkerLease(run,worker,1,"nonce")
    async def invoke(self,lease,method,params,timeout_ms=120000):
        self.calls.append((method,params)); return {"method":method}
    async def release(self,lease): self.released.append(lease); return True

@pytest.mark.asyncio
async def test_exact_task_only_and_release():
    rt=Runtime(rlm=True); tx=FakeTransport(); rt._host_worker_transport=tx
    gate=asyncio.Event()
    async def entry(root):
        await gate.wait()
        child=asyncio.create_task(root.tools.list())
        with pytest.raises(Exception): await child
        return await root.tools.list()
    async def callback(*args): raise AssertionError
    async with rt.bind():
        async with rt._bind_host_callbacks("cell",callback): h=await rt.host_workers.spawn(entry,timeout=2)
    gate.set(); assert (await h)["method"]=="tools.list"
    assert tx.released==[h.lease]


@pytest.mark.asyncio
async def test_program_agent_automatically_keeps_exact_task_host_authority():
    from dsh_rlm.host_workers import HostWorkerLease

    class Transport:
        def __init__(self):
            self.invoked = []
            self.released = []

        async def admit(self, parent, run, worker, lifetime):
            return HostWorkerLease(run, worker, 1, "program-lease")

        async def invoke(self, lease, method, params, timeout_ms=120000):
            self.invoked.append((lease, method, params))
            return {"method": method}

        async def release(self, lease):
            self.released.append(lease)
            return True

    root = Runtime(rlm=True)
    transport = Transport()
    root._host_worker_transport = transport
    proceed = asyncio.Event()

    async def program(child):
        await proceed.wait()
        descendant = asyncio.create_task(child.tools.list())
        with pytest.raises(UnsupportedOperationError, match="exact admitted program-agent task"):
            await descendant
        return await child.tools.list()

    callback_calls = 0
    async def callback(*_args):
        nonlocal callback_calls
        callback_calls += 1
        return {"stale": True}

    async with root.bind():
        async with root._bind_host_callbacks("creating-cell", callback):
            handle = await root.spawn_program(program, name="host-capable-program")
            proceed.set()
            # The raw descendant is denied even while the creating cell scope
            # remains active; inherited worker context cannot fall back to it.
            assert await handle.wait() == {"method": "tools.list"}

    assert [item[1] for item in transport.invoked] == ["tools.list"]
    assert len(transport.released) == 1
    assert callback_calls == 0
    await root.close()


@pytest.mark.asyncio
async def test_admission_requires_active_cell():
    rt=Runtime(rlm=True); rt._host_worker_transport=FakeTransport()
    async def entry(_): return 1
    with pytest.raises(HostWorkerError) as exc: await rt.host_workers.spawn(entry)
    assert exc.value.code=="ADMISSION_DENIED"

def test_error_metadata():
    e=HostWorkerError("AMBIGUOUS","unknown",effect_id="effect",outcome_unknown=True)
    assert e.effect_id=="effect" and e.outcome_unknown

@pytest.mark.asyncio
async def test_outcome_snapshot_survives_transport_detach():
    rt=Runtime(rlm=True)
    rt._host_worker_outcomes.append({"invocation_id":"i","effect_id":None,"outcome_unknown":True,"reason":"retired"})
    rt._host_worker_transport=None
    snapshot=rt.host_workers.inspect_outcomes()
    assert snapshot==({"invocation_id":"i","effect_id":None,"outcome_unknown":True,"reason":"retired"},)
    snapshot[0]["reason"]="changed"
    assert rt.host_workers.inspect_outcomes()[0]["reason"]=="retired"

@pytest.mark.asyncio
async def test_withheld_admission_cancel_retires(monkeypatch):
 import dsh_rlm.host_workers as hw
 monkeypatch.setattr(hw,"_CLEANUP_TIMEOUT_SECONDS",.01)
 class Tx(FakeTransport):
  def __init__(self): super().__init__(); self.retired=[]
  async def admit(self,*args): await asyncio.Event().wait()
  def retire(self,reason): self.retired.append(reason)
 rt=Runtime(rlm=True); tx=Tx(); rt._host_worker_transport=tx
 async def entry(_): return 1
 async def cb(*args): pass
 async with rt.bind():
  async with rt._bind_host_callbacks("cell",cb):
   pending=asyncio.create_task(rt.host_workers.spawn(entry)); await asyncio.sleep(0); pending.cancel()
   with pytest.raises(asyncio.CancelledError): await pending
 assert tx.retired==["worker admission outcome unknown"] and not rt._host_worker_cleanup_tasks

@pytest.mark.asyncio
async def test_withheld_release_cancelled_and_drained(monkeypatch):
 import dsh_rlm.host_workers as hw
 monkeypatch.setattr(hw,"_CLEANUP_TIMEOUT_SECONDS",.01)
 class Tx(FakeTransport):
  cancelled=False
  async def release(self,lease):
   try: await asyncio.Event().wait()
   except asyncio.CancelledError: self.cancelled=True; raise
 rt=Runtime(rlm=True); tx=Tx(); rt._host_worker_transport=tx
 async def entry(_): return 1
 async def cb(*args): pass
 async with rt.bind():
  async with rt._bind_host_callbacks("cell",cb): h=await rt.host_workers.spawn(entry)
 assert await h==1 and tx.cancelled and not rt._host_worker_cleanup_tasks
