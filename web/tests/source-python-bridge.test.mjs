// SYNTHETIC only: real bundled Python helpers, no network, broker, model or runtime file writes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

test("SYNTHETIC Python source gate preserves actual provider, blocks Sandbox/incomplete TS, and namespaces every epoch before state/configuration", () => {
  const root = resolve(import.meta.dirname, "../.."), python = join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  assert.ok(existsSync(python), "Install this package's locked Python environment first; no global fallback or skipped gate");
  const code = String.raw`import copy,hashlib,json,os,runpy,sys
from pathlib import Path
sys.dont_write_bytecode=True
def audit(event,args):
 if event in ('socket.connect','subprocess.Popen'): raise AssertionError('SYNTHETIC test forbids network/process calls')
sys.addaudithook(audit)
root=Path(sys.argv[1]); sys.path.insert(0,str(root/'v2-reference'))
m=runpy.run_path(str(root/'web/scripts/live-shadow-v2.py')); g=m['run_step'].__globals__
def chosen(revision=1,provider='TRADIER',environment='LIVE'):
 body={'version':1,'revision':revision,'selected':{'market':{'provider':provider,'environment':environment},'news':{'provider':'OFFICIAL_ONLY'},'broker':{'provider':'NONE'}}}
 return {**body,'selection_id':hashlib.sha256(json.dumps(body,separators=(',',':')).encode()).hexdigest()}
def blocked(fn):
 try: fn()
 except m['DataBlocked']: return
 raise AssertionError('Expected a fail-closed source gate')
s=chosen(); assert m['validate_source_selection'](s)==s
for bad in [dict(s,version=True),dict(s,revision=True),dict(s,selection_id='f'*64),chosen(environment='SANDBOX')]: blocked(lambda:m['validate_source_selection'](bad))
os.environ['TRADING_OS_PUBLIC_AUTOMATION']='1'; blocked(lambda:m['validate_source_selection'](None))
caps={key:True for key in ('option_chain','option_bbo','option_iv','option_greeks')}
snapshot={'status':'LIVE','providers':[{'source':'TRADIER','status':'LIVE'}],'quotes':[{'source':'TRADIER'}],'bars':[],'options':[],'capabilities':caps}
assert m['require_market_snapshot'](snapshot,s)=='TRADIER'
for change in [{'delayed':True},{'environment':'sandbox'},{'quotes':[{'source':'ROBINHOOD'}]},{'capabilities':dict(caps,option_iv=False)}]: blocked(lambda:m['require_market_snapshot']({**snapshot,**change},s))
rh=chosen(provider='ROBINHOOD'); assert m['require_market_snapshot']({'status':'LIVE','providers':[{'source':'ROBINHOOD','status':'LIVE'}],'quotes':[{'source':'ROBINHOOD'}]},rh)=='ROBINHOOD'
at='2026-08-11T13:30:00+00:00'; paths=[]; writes=[]
g['configure']=lambda v2,data:(paths.append(data) or {},None,None,None)
g['collect_official_macro_context']=lambda *args:{'collected_at':at,'as_of':at,'synthetic':True}
g['atomic_json']=lambda path,value:writes.append(path)
base=root/'_工作文件'/'synthetic-python-state-no-write'
for value in [s,chosen(2),rh]:
 result=m['run_step']({'component':'OFFICIAL_MACRO','input':{'SOURCE_SELECTION':value,'source_mode':'LIVE','run_id':'SYNTHETIC'}},root/'v2-reference',base)
 assert value['selection_id'] in result['evidenceRef']
 assert paths[-1]==base/'source-selections'/value['selection_id']
 assert m['pattern_state_path'](paths[-1],'LIVE').is_relative_to(paths[-1])
assert len(set(paths))==3 and all(path.is_relative_to(base) for path in writes)
os.environ.pop('TRADING_OS_PUBLIC_AUTOMATION'); assert m['validate_source_selection'](None) is None
m['run_step']({'component':'OFFICIAL_MACRO','input':{'source_mode':'LIVE','run_id':'SYNTHETIC'}},root/'v2-reference',base)
assert paths[-1]==base and m['pattern_state_path'](base,'LIVE')==base/'v2-data/a2/pattern_tracker.json'
assert not base.exists(), 'No runtime files were written'
print(json.dumps({'classification':'SYNTHETIC','source_gates':'PASS','epoch_state':'PASS','provider_calls':0,'model_calls':0,'runtime_writes':0}))
`;
  const result = spawnSync(python, ["-I", "-X", "utf8", "-B", "-c", code, root], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 100_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { classification: "SYNTHETIC", source_gates: "PASS", epoch_state: "PASS", provider_calls: 0, model_calls: 0, runtime_writes: 0 });
});
