"""Bounded deterministic views over retained exact-builtin tool data."""
from __future__ import annotations
from dataclasses import dataclass, field
from itertools import islice
from typing import Any, Sequence

_CRITICAL_KEYS = ("error", "errors", "stderr", "denied", "approval", "approvals", "recovery", "recovery_notice", "aborted", "timedout", "timed_out", "exitcode", "exit_code", "signal")

@dataclass(frozen=True, slots=True)
class Inspection:
    """A bounded view; the complete live source is deliberately absent from repr."""
    source: Any = field(repr=False, compare=False)
    value: Any
    path: tuple[str | int, ...]
    truncated: bool
    omitted: int
    notes: tuple[str, ...] = ()
    def at(self, *path: str | int, **bounds: int) -> "Inspection":
        return inspect_value(self.source, path=(*self.path, *path), **bounds)

def compact_tools(catalogue: Any, *, offset: int = 0, max_tools: int = 40, max_name: int = 128, max_description: int = 160) -> Inspection:
    """Inspect an exact list catalogue; reject arbitrary iterables and unsafe identities."""
    if type(catalogue) is not list:
        raise TypeError("catalogue must be an exact list")
    if offset < 0 or min(max_tools, max_name) < 1 or max_description < 0 or max_tools > 100 or max_name > 512 or max_description > 2000:
        raise ValueError("invalid catalogue bounds")
    rows, omitted, notes = [], 0, []
    # Inspect at most max_tools valid entries; no unbounded sorting/copying.
    page = catalogue[offset:offset + max_tools]
    for entry in page:
        if type(entry) is not dict:
            omitted += 1; continue
        fields = {key: item for key, item in entry.items() if type(key) is str and key in ("name", "description")}
        name, description = fields.get("name"), fields.get("description")
        if type(name) is not str or not name or len(name) > max_name:
            omitted += 1; notes.append("tool omitted because exact name was unsafe or over limit"); continue
        if len(rows) >= max_tools:
            omitted += 1; continue
        if type(description) is not str: description = ""
        cut = len(description) > max_description
        rows.append({"name": name, "description": description[:max_description], "description_truncated": cut})
    omitted += len(catalogue) - len(page)
    rows.sort(key=lambda row: row["name"])
    return Inspection(catalogue, rows, (), bool(omitted or any(r["description_truncated"] for r in rows)), omitted, tuple(dict.fromkeys(notes)))

def tool_schema(catalogue: Any, name: str) -> Any:
    """Explicit full snapshot expansion; never grants current execution authority."""
    if type(catalogue) is not list or type(name) is not str: raise TypeError("exact list and string required")
    matches=[]
    for entry in catalogue:
        if type(entry) is not dict: continue
        stored = next((item for key, item in entry.items() if type(key) is str and key == "name"), None)
        if type(stored) is str and stored == name: matches.append(entry)
    if not matches: raise KeyError(name)
    if len(matches)!=1: raise ValueError("duplicate tool name")
    return matches[0]

def _resolve(value: Any, path: Sequence[str | int]) -> Any:
    if type(path) not in (tuple, list):
        raise TypeError("path must be an exact list or tuple")
    current=value
    for part in path:
        if type(current) is dict and type(part) in (str,int):
            found = False
            for key, item in current.items():
                if type(key) is type(part) and key == part:
                    current, found = item, True
                    break
            if not found: raise KeyError(part)
        elif type(current) in (list,tuple) and type(part) is int:
            current=current[part]
        else: raise TypeError("cannot traverse requested path")
    return current

def inspect_value(source: Any, *, path: Sequence[str | int]=(), offset: int=0, max_depth: int=4, max_items: int=20, max_string: int=500, max_key: int=128, max_int_bits: int=256, max_nodes: int=100) -> Inspection:
    """Bounded inspection with one total node budget and safe exact builtins only."""
    if min(max_depth,max_string,max_key,max_int_bits,offset) < 0 or min(max_items,max_nodes) < 1 or max_depth > 20 or max_items > 100 or max_nodes > 1000 or max_string > 10000 or max_key > 512 or max_int_bits > 4096: raise ValueError("invalid inspection bounds")
    selected, notes, seen, budget = _resolve(source,path), [], set(), [max_nodes]
    def walk(value: Any, depth: int) -> tuple[Any,bool,int]:
        if budget[0] <= 0: return {"type":"budget","opaque":True},True,1
        budget[0]-=1
        if type(value) in (dict,list,tuple):
            ident=id(value)
            if ident in seen: return {"type":"reference","retained":True},False,0
            seen.add(ident)
        if type(value) is dict:
            if depth>=max_depth: return {"type":"mapping","length":len(value)},bool(value),len(value)
            out, chosen, unsafe = {}, [], 0
            # Scan exact primitive keys: no lookup can dispatch hostile key hash/equality.
            critical = {key: item for key, item in value.items() if type(key) is str and key in _CRITICAL_KEYS}
            for key in _CRITICAL_KEYS:
                if key in critical: chosen.append((key, critical[key]))
            start=offset if depth==0 else 0
            ordinary=(item for item in value.items() if type(item[0]) in (str,int) and not (type(item[0]) is str and item[0] in _CRITICAL_KEYS))
            window=list(islice(ordinary,start,start+max_items))
            for key,item in window:
                if type(key) is str and len(key)<=max_key: chosen.append((key,item))
                elif type(key) is int and key.bit_length()<=max_int_bits: chosen.append((key,item))
                else: unsafe+=1
            omitted=max(0,len(value)-len(chosen)); cut=omitted>0
            for key,item in chosen:
                if budget[0] <= 0:
                    omitted += len(chosen) - len(out); cut = True; break
                child,c,n=walk(item,depth+1); out[key]=child; cut|=c; omitted+=n
            if unsafe: notes.append("mapping key(s) omitted without rendering")
            return out,cut,omitted
        if type(value) in (list,tuple):
            if depth>=max_depth: return {"type":"sequence","length":len(value)},bool(value),len(value)
            start=offset if depth==0 else 0; part=value[start:start+max_items]; out=[]; omitted=max(0,len(value)-len(part)); cut=omitted>0
            for item in part:
                if budget[0] <= 0:
                    omitted += len(part) - len(out); cut = True; break
                child,c,n=walk(item,depth+1); out.append(child); cut|=c; omitted+=n
            return out,cut,omitted
        if value is None or type(value) in (bool,float): return value,False,0
        if type(value) is int:
            return (value,False,0) if value.bit_length()<=max_int_bits else ({"type":"integer","bits":value.bit_length(),"opaque":True},True,1)
        if type(value) is str: return (value,False,0) if len(value)<=max_string else (value[:max_string],True,len(value)-max_string)
        if type(value) is bytes: return {"type":"bytes","hex":value[:max_string].hex(),"length":len(value)},len(value)>max_string,max(0,len(value)-max_string)
        return {"type":"unsupported","opaque":True},False,0
    view,truncated,omitted=walk(selected,0)
    return Inspection(source,view,tuple(path),truncated,omitted,tuple(dict.fromkeys(notes)))
