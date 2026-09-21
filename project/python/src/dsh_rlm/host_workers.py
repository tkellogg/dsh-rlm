"""Explicit host-capable local workers with process-live bridge leases."""
from __future__ import annotations
import asyncio, inspect, math, uuid, weakref
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Generic, TypeVar

T=TypeVar("T")
_CLEANUP_TIMEOUT_SECONDS=5.0

class HostWorkerError(Exception):
    def __init__(self, code: str, message: str, *, effect_id: str|None=None, outcome_unknown: bool=False):
        self.code=code; self.message=message; self.effect_id=effect_id; self.outcome_unknown=outcome_unknown
        super().__init__(f"{code}: {message}")

@dataclass(frozen=True, slots=True)
class HostWorkerLease:
    run_id: str; worker_id: str; generation: int; admission_id: str
    def wire(self)->dict[str,Any]:
        return {"run_id":self.run_id,"worker_id":self.worker_id,"generation":self.generation,"admission_id":self.admission_id}

_TASK_LEASES: weakref.WeakKeyDictionary[asyncio.Task[Any], tuple[Any,HostWorkerLease]] = weakref.WeakKeyDictionary()

def worker_lease(runtime: Any)->HostWorkerLease|None:
    task=asyncio.current_task()
    item=_TASK_LEASES.get(task) if task is not None else None
    return item[1] if item is not None and item[0] is runtime else None

@dataclass(frozen=True, slots=True)
class HostWorkerHandle(Generic[T]):
    id: str
    name: str|None
    task: asyncio.Task[T]
    lease: HostWorkerLease
    def __await__(self): return self.task.__await__()
    async def result(self)->T: return await self.task
    def cancel(self)->bool: return self.task.cancel()
    @property
    def done(self)->bool: return self.task.done()
    @property
    def cancelled(self)->bool: return self.task.cancelled()
    def exception(self)->BaseException|None: return self.task.exception()

class HostWorkers:
    def __init__(self, runtime: Any): self._runtime=runtime
    def inspect_outcomes(self)->tuple[dict[str,Any],...]:
        return tuple(dict(item) for item in self._runtime._host_worker_outcomes)
    async def spawn(self, entry: Callable[[Any],Awaitable[T]], *, name: str|None=None, timeout: float|None=None)->HostWorkerHandle[T]:
        if not callable(entry): raise TypeError("entry must be an async callable")
        if name is not None and (not isinstance(name,str) or len(name)>256): raise ValueError("name must be a string of at most 256 characters")
        if timeout is not None and (isinstance(timeout,bool) or not isinstance(timeout,(int,float)) or not math.isfinite(timeout) or timeout<=0 or timeout>120): raise ValueError("timeout must be a finite number in (0, 120]")
        runtime=self._runtime; transport=getattr(runtime,"_host_worker_transport",None)
        if transport is None: raise HostWorkerError("WORKERS_UNAVAILABLE","host workers are not attached")
        from .runtime import _HOST_CALLBACK_SCOPE, _CURRENT_RUNTIME
        scope=_HOST_CALLBACK_SCOPE.get(); current=asyncio.current_task()
        if not runtime.authoritative or not runtime._rlm or _CURRENT_RUNTIME.get() is not runtime or scope is None or not scope.active or scope.state is not runtime._state or current is None: raise HostWorkerError("ADMISSION_DENIED","worker admission requires an active execute cell")
        worker_id="worker-"+uuid.uuid4().hex
        admission=asyncio.create_task(transport.admit(scope.parent_id,runtime.agent_id,worker_id,None if timeout is None else max(1,int(timeout*1000))))
        runtime._host_worker_cleanup_tasks.add(admission)
        try:
            lease=await asyncio.wait_for(admission,_CLEANUP_TIMEOUT_SECONDS)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            retire=getattr(transport,"retire",None)
            if retire is not None: retire("worker admission outcome unknown")
            runtime._host_worker_transport=None
            raise
        finally:
            runtime._host_worker_cleanup_tasks.discard(admission)
        released=False
        release_lock=asyncio.Lock()
        async def cleanup()->None:
            nonlocal released
            async with release_lock:
                if released: return
                released=True
                release=asyncio.create_task(transport.release(lease))
                runtime._host_worker_cleanup_tasks.add(release)
                try: await asyncio.wait_for(release,_CLEANUP_TIMEOUT_SECONDS)
                except BaseException:
                    if not release.done(): release.cancel()
                    await asyncio.gather(release,return_exceptions=True)
                finally: runtime._host_worker_cleanup_tasks.discard(release)
        if not runtime.authoritative or not scope.active:
            await cleanup(); raise HostWorkerError("ADMISSION_REVOKED","runtime or execute cell ended during admission")
        started=asyncio.Event()
        async def run()->T:
            task=asyncio.current_task(); assert task is not None
            _TASK_LEASES[task]=(runtime,lease); started.set()
            try:
                value=entry(runtime)
                if not inspect.isawaitable(value): raise TypeError("entry must return an awaitable")
                if timeout is None: return await value
                async with asyncio.timeout(float(timeout)): return await value
            finally:
                _TASK_LEASES.pop(task,None); await cleanup()
        try:
            task=asyncio.create_task(run(),name=name)
        except BaseException:
            await cleanup()
            raise
        runtime._host_worker_tasks.add(task)
        def done(_task: asyncio.Task[Any])->None:
            runtime._host_worker_tasks.discard(_task); started.set()
        task.add_done_callback(done)
        try:
            await started.wait()
            if task.done(): await task
        except BaseException:
            if not task.done(): task.cancel()
            await asyncio.gather(task,return_exceptions=True)
            await cleanup(); raise
        return HostWorkerHandle(worker_id,name,task,lease)
