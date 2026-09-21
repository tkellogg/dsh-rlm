from __future__ import annotations
import json, queue, subprocess, sys, threading
from pathlib import Path
import pytest

_PROCESSES=[]
_READERS={}

@pytest.fixture(autouse=True)
def _cleanup_processes():
 yield
 while _PROCESSES:
  p=_PROCESSES.pop()
  if p.poll() is None:
   p.terminate()
   try: p.wait(timeout=2)
   except subprocess.TimeoutExpired:
    p.kill(); p.wait(timeout=2)

def _start(path):
 p=subprocess.Popen([sys.executable,"-m","dsh_rlm.bridge","--session-dir",str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 assert p.stdout is not None
 lines=queue.Queue()
 def read_lines():
  for line in p.stdout: lines.put(line)
  lines.put(None)
 threading.Thread(target=read_lines,daemon=True).start()
 _READERS[p]=lines; _PROCESSES.append(p); return p
def _w(p,v): p.stdin.write(json.dumps(v)+"\n"); p.stdin.flush()
def _r(p,timeout=5):
 try: line=_READERS[p].get(timeout=timeout)
 except queue.Empty: raise AssertionError("timed out waiting for bridge protocol frame")
 assert line,(p.stderr.read() if p.stderr else "")
 return json.loads(line)

def test_independent_worker_protocol_after_final_cell(tmp_path: Path):
 p=_start(tmp_path/"s")
 source="import asyncio\nasync def work(root):\n await asyncio.sleep(.02)\n return await root.tools.list()\nh=await runtime.host_workers.spawn(work, timeout=5)"
 _w(p,{"id":"cell","method":"execute","capabilities":["host-callback-v1"],"source":source})
 admit=_r(p); assert admit["kind"]=="worker_admit" and admit["parent_id"]=="cell"
 lease={"run_id":admit["run_id"],"worker_id":admit["worker_id"],"generation":1,"admission_id":"nonce"}
 _w(p,{"kind":"worker_admit_result","id":admit["id"],"ok":True,"lease":lease})
 final=_r(p); assert final["id"]=="cell"
 invoke=_r(p); assert invoke["kind"]=="worker_invoke" and invoke["method"]=="tools.list" and invoke["timeout_ms"]==120000
 _w(p,{"kind":"worker_result","id":invoke["id"],"ok":True,"effect_id":"effect-1","result":[{"name":"ok"}]})
 release=_r(p); assert release["kind"]=="worker_release"
 _w(p,{"kind":"worker_release_result","id":release["id"],"ok":True,"released":True})
 _w(p,{"id":"result","method":"execute","source":"await h"}); assert _r(p)["result"]["cell"]["ok"]
 _w(p,{"id":"close","method":"close"}); assert _r(p)["ok"]; assert p.wait(timeout=10)==0


def test_program_agent_automatically_calls_host_after_creating_cell(tmp_path: Path):
 p=_start(tmp_path/"program")
 source="import asyncio\nasync def program(child):\n await asyncio.sleep(.02)\n return await child.tools.list()\nh=await runtime.spawn_program(program, name='program-agent')"
 _w(p,{"id":"cell","method":"execute","capabilities":["host-callback-v1"],"source":source})
 admit=_r(p); assert admit["kind"]=="worker_admit" and admit["parent_id"]=="cell"
 lease={"run_id":admit["run_id"],"worker_id":admit["worker_id"],"generation":1,"admission_id":"program-nonce"}
 _w(p,{"kind":"worker_admit_result","id":admit["id"],"ok":True,"lease":lease})
 final=_r(p); assert final["id"]=="cell" and final["result"]["cell"]["ok"]
 invoke=_r(p); assert invoke["kind"]=="worker_invoke" and invoke["method"]=="tools.list"
 _w(p,{"kind":"worker_result","id":invoke["id"],"ok":True,"effect_id":"program-effect","result":[{"name":"send_message"}]})
 release=_r(p); assert release["kind"]=="worker_release"
 _w(p,{"kind":"worker_release_result","id":release["id"],"ok":True,"released":True})
 _w(p,{"id":"result","method":"execute","source":"await h.wait()"})
 result=_r(p); assert result["result"]["cell"]["ok"] and "send_message" in result["result"]["cell"]["display"]
 _w(p,{"id":"close","method":"close"}); assert _r(p)["ok"]; assert p.wait(timeout=10)==0


def test_worker_error_preserves_unknown_effect_metadata(tmp_path: Path):
 p=_start(tmp_path/"s")
 source="async def work(root):\n return await root.tools.list()\nh=await runtime.host_workers.spawn(work)"
 _w(p,{"id":"cell","method":"execute","capabilities":["host-callback-v1"],"source":source})
 admit=_r(p); lease={"run_id":admit["run_id"],"worker_id":admit["worker_id"],"generation":2,"admission_id":"nonce"}
 _w(p,{"kind":"worker_admit_result","id":admit["id"],"ok":True,"lease":lease})
 first=_r(p); second=_r(p); invoke=first if first.get("kind")=="worker_invoke" else second
 assert (second if invoke is first else first)["id"]=="cell"
 _w(p,{"kind":"worker_result","id":invoke["id"],"ok":False,"effect_id":"effect-x","error":{"code":"AMBIGUOUS","message":"unknown","outcome_unknown":True}})
 release=_r(p); _w(p,{"kind":"worker_release_result","id":release["id"],"ok":True,"released":True})
 _w(p,{"id":"inspect","method":"execute","source":"try:\n await h\nexcept Exception as e:\n outcome=(e.code,e.effect_id,e.outcome_unknown)\noutcome"})
 response=_r(p); assert "effect-x" in response["result"]["cell"]["display"] and "True" in response["result"]["cell"]["display"]
 _w(p,{"id":"close","method":"close"}); _r(p); assert p.wait(timeout=10)==0
