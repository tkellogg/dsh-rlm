from __future__ import annotations
import pytest
from dsh_rlm.context_inspection import compact_tools, inspect_value, tool_schema

def test_compact_catalogue_bounded_exact_identity_and_schema_on_demand():
    catalogue=[{"name":f"t{i:03}","description":"d"*1000,"parameters":{"huge":"x"*1000}} for i in range(100)]
    view=compact_tools(catalogue,max_tools=3,max_description=8)
    assert len(view.value)==3 and view.truncated and view.omitted==97
    assert all(row["description_truncated"] and len(row["description"])==8 for row in view.value)
    assert tool_schema(view.source,"t099")["parameters"]["huge"]=="x"*1000
    with pytest.raises(TypeError): compact_tools(iter(catalogue))
    long=[{"name":"x"*200,"description":"d"}]
    assert compact_tools(long,max_name=10).value==[]
    assert "x"*10 not in repr(compact_tools(long,max_name=10))

def test_nested_pagination_and_total_node_budget():
    source={"rows":[{"text":"abcdefgh","n":i} for i in range(100)]}
    view=inspect_value(source,max_items=2,max_string=3)
    assert view.source is source and view.truncated
    assert view.at("rows",offset=50,max_items=2,max_string=20).value[0]["n"]==50
    wide={str(i):[{"x":i} for _ in range(10)] for i in range(100)}
    bounded=inspect_value(wide,max_items=100,max_nodes=5)
    assert bounded.truncated and len(repr(bounded)) < 1200

def test_critical_supported_envelope_precedes_ordinary_window_but_node_bounded():
    source={"ordinary":"shown","later":"hidden","stderr":"boom","denied":True,"recovery":{"lost":2}}
    value=inspect_value(source,max_items=1).value
    assert value=={"stderr":"boom","denied":True,"recovery":{"lost":2},"ordinary":"shown"}
    assert inspect_value(source,max_items=1,max_nodes=2).truncated

def test_hostile_source_never_enters_repr_or_callbacks():
    class Hostile:
        @property
        def bad(self): raise AssertionError("property")
        def __repr__(self): raise AssertionError("repr")
        def __str__(self): raise AssertionError("str")
        def __iter__(self): raise AssertionError("iter")
        def __getitem__(self,key): raise AssertionError("getitem")
    class EvilDict(dict):
        def items(self): raise AssertionError("items")
    class EvilList(list):
        def __getitem__(self,item): raise AssertionError("getitem")
    source={"x":Hostile(),"d":EvilDict(a=1),"l":EvilList([1])}
    view=inspect_value(source)
    assert all(v=={"type":"unsupported","opaque":True} for v in view.value.values())
    assert "source=" not in repr(view)

def test_cycles_aliases_huge_keys_and_scalars_strictly_bounded():
    cycle=[]; cycle.append(cycle); shared={"x":1}; huge=1 << 1_000_000
    source={"cycle":cycle,"a":shared,"b":shared,"integer":huge,"blob":b"a"*10000,"text":"z"*10000,"k"*10000:1,huge:2}
    view=inspect_value(source,max_items=20,max_string=10,max_int_bits=32)
    assert view.value["cycle"][0]=={"type":"reference","retained":True}
    assert view.value["b"]=={"type":"reference","retained":True}
    assert view.value["integer"]=={"type":"integer","bits":1000001,"opaque":True}
    assert view.value["blob"]["hex"]=="61"*10 and view.value["text"]=="z"*10
    assert len(repr(view)) < 700

def test_invalid_bounds_missing_and_duplicate_schema():
    with pytest.raises(ValueError): inspect_value({},max_items=0)
    with pytest.raises(KeyError): tool_schema([],"x")
    with pytest.raises(ValueError): tool_schema([{"name":"x"},{"name":"x"}],"x")

def test_hostile_stored_keys_schema_values_and_source_repr_regressions():
    class Evil:
        def __hash__(self): return hash("name")
        def __eq__(self, other): raise AssertionError("equality callback")
        def __repr__(self): raise AssertionError("repr callback")
    evil = Evil()
    source = {evil: "hostile", "safe": 1}
    view = inspect_value(source, path=("safe",))
    assert view.value == 1 and "source=" not in repr(view)
    catalogue = [{"name": evil}, {"name": "safe", "parameters": {}}]
    assert tool_schema(catalogue, "safe") is catalogue[1]


def test_critical_envelope_exact_node_budget_omissions():
    source = {"stderr": "boom", "denied": True, "recovery": {"lost": 2}, "ordinary": "shown"}
    one = inspect_value(source, max_items=1, max_nodes=1)
    assert one.value == {} and one.truncated and one.omitted == 4
    two = inspect_value(source, max_items=1, max_nodes=2)
    assert two.value == {"stderr": "boom"} and two.truncated and two.omitted == 3

