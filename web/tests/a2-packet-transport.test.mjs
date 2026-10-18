import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { APPROVED_UNIVERSE } from "../app/snapshot-import.ts";

const v2 = resolve(import.meta.dirname, "../../v2-reference");

for (const session of ["CLOSED", "REGULAR"]) test(`A2 ${session} position packet survives Node transport and still rejects invalid proposals`, () => {
  assert.ok(existsSync(join(v2, "trading_os_v2")), "The bundled core is mandatory");
  const code = `import copy,json,runpy,subprocess,sys,tempfile
from datetime import datetime,UTC
from pathlib import Path
sys.dont_write_bytecode=True
v2=Path(${JSON.stringify(v2)})
sys.path.insert(0,str(v2))
from trading_os_v2.a2 import service as a2_service
from trading_os_v2.a2.pattern_tracker import MarketPatternTracker
from trading_os_v2.agent_runtime.service import _verify_packet,_verify_supplemental,AgentFailure
from trading_os_v2.common.io import sha256_json
m=runpy.run_path('scripts/live-shadow-v2.py')
g=m['run_step'].__globals__
at='2026-09-09T01:00:00+00:00'
session=${JSON.stringify(session)}
class Clock(datetime):
 @classmethod
 def now(cls,tz=None): return datetime.fromisoformat(at)
g['datetime']=Clock
# Only the upstream market/A2 analysis is synthetic. The real position monitor,
# both adapter packet hashes, frozen proof, wrapper and TS verifier are exercised.
g['generic_market_to_v2']=lambda snapshot,*args:{'positions':m['supported_v2_positions'](snapshot)}
watch={'contract_version':'v1','component':'A1_EARNINGS_WATCH','actionable':False,'status':'DEGRADED','generated_at':at,'timezone':'America/Los_Angeles','window_start':'2026-09-08','window_end':'2026-09-14','selection_rule':'TOP_20_ABSOLUTE_REVENUE_ESTIMATE','events':[]}
class Analyzer:
 def __init__(self,config,**kwargs): self.tracker=MarketPatternTracker(config,kwargs['pattern_state_path'])
 def analyze(self,raw): return {'analyzed_at':at,'data_gaps':[],'pattern_tracker':self.tracker.update({'collected_at':at,'market':{'clock':{'state':'open' if session=='REGULAR' else 'closed'},'timesales':{}}},{})}
 def freeze(self,raw,analysis): return {'contract_version':'v1','created_at':at,'a1':{'health':{'state':'HEALTHY'},'positions':copy.deepcopy(raw['positions']),'earnings_watch':watch,'macro_results':[]}}
a2_service.A2Analyzer=Analyzer
macro=m['frozen_context']({'component':'OFFICIAL_MACRO_CONTEXT','as_of':at},sha256_json)
holding={'contract_id':'test-spy-call','symbol':'SPY','option_type':'call','expiration':'2026-09-11','strike':100,'direction':'long','quantity':2,'average_price':2,'bid':2.4,'ask':2.45,'mark':2.425,'as_of':at}
snapshot={'status':'MARKET_CLOSED' if session=='CLOSED' else 'LIVE','generated_at':at,'as_of':at,'snapshot_id':'fixture','snapshot_hash':'b'*64,'market_session':{'state':session},'options':[],'account':{'source':'ROBINHOOD','status':'LIVE','as_of':at,'positions':[holding]}}
snapshot['approved_capabilities']={'contract_version':'v3','component':'APPROVED_CAPABILITY_SNAPSHOT','mode':'SHADOW','actionable':False,'fixed_pool':{'universe_size':90,'rows':[{'symbol':symbol,'last':None} for symbol in ${JSON.stringify(APPROVED_UNIVERSE)}]}}
request={'component':'A2','input':{'source_mode':'LIVE','run_id':'isolated-packet-fixture','RUN_REASON':'4070 Live Shadow' if session=='REGULAR' else '次日提前分析','A1':{'market_sources':snapshot,'official_macro':macro}}}
before=sha256_json(request)
Path('data/live-shadow').mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='a2-packet-transport-',dir='data/live-shadow') as folder:
 _,_,orchestrator,_=m['configure'](v2,Path(folder))
 regular={**snapshot,'market_session':{'state':'REGULAR'}}
 seed,gaps=m['frozen_position_monitor'](regular,m['supported_v2_positions'](regular),Path(folder),at,orchestrator)
 assert not gaps and seed['positions'][0]['max_drawdown_from_peak_pct']==0
 result=m['run_step'](request,v2,Path(folder))
 assert result['payload']['pattern_evidence']['status']==('INITIALIZING' if session=='REGULAR' else 'INACTIVE')
 for symbol in ('SPY','QQQ'):
  assert result['payload']['v2_result']['analysis']['pattern_tracker']['symbols'][symbol]['data_time']=='', 'Adapter changed raw upstream evidence'
  assert result['payload']['pattern_evidence']['symbols'][symbol]['data_time'] is None, 'Unobserved pattern time must be explicit null'
 packet=result['payload']['v2_result']['packet']
 assert bool(packet['selected_position_events'])==(session=='REGULAR')
 assert packet['position_monitor']['positions'][0]['max_drawdown_from_peak_pct']==0
 _verify_packet(packet)
 node=subprocess.run([${JSON.stringify(process.execPath)},'-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))))"],input=json.dumps(result),text=True,encoding='utf-8',capture_output=True,check=True)
 transported=json.loads(node.stdout)
 frozen=transported['payload']['v2_result']['packet']
 _verify_packet(frozen)
 assert transported['payload']['result_hash']==sha256_json(transported['payload']['v2_result'])
 assert packet==frozen, 'Node transport changed substantive evidence'
 assert frozen['position_monitor']['positions'][0]['position_snapshot_hash']==seed['positions'][0]['position_snapshot_hash'], 'Packet transport changed existing owner position identity'
 assert frozen['run_id'].endswith(frozen['packet_hash'][:10])
 proof=transported['payload']['v2_result']['input_freshness']
 assert proof['session_mode']==('OPEN' if session=='REGULAR' else 'NON_OPEN')
 assert proof['packet_hash']==frozen['packet_hash'] and proof['run_id']==frozen['run_id']
 original=transported['payload']['v2_result']['approved_capabilities']
 assert original==snapshot['approved_capabilities'] and proof['approved_capabilities_hash']==sha256_json(original)
 risk=m['frozen_context']({'component':'TS_REGIME_RISK_CONTEXT','market_snapshot_id':'fixture','market_snapshot_hash':'b'*64},sha256_json)
 cycle_input={'A2':transported['payload'],'source_mode':'LIVE','TS_REGIME_RISK_CONTEXT':risk}
 transported_hash=sha256_json(transported)
 cycle=m['frozen_cycle'](cycle_input,sha256_json)
 assert cycle[0]==frozen
 adapted=cycle[5]
 assert adapted=={'source_contract_version':'v3',**{key:value for key,value in original.items() if key!='contract_version'}}
 assert len(adapted['fixed_pool']['rows'])==adapted['fixed_pool']['universe_size']==90
 _verify_supplemental({'approved_capabilities':adapted})
 try: _verify_supplemental({'approved_capabilities':original})
 except AgentFailure as exc: assert str(exc)=='Unknown supplemental input contract version'
 else: raise AssertionError('Raw v3 unexpectedly bypassed the legacy version gate')
 changed_cycle=copy.deepcopy(cycle_input)
 changed_cycle['A2']['v2_result']['approved_capabilities']['fixed_pool']['rows'][0]['last']=123
 try: m['frozen_cycle'](changed_cycle,sha256_json)
 except m['DataBlocked'] as exc: assert str(exc)=='下游已批准能力冻结上下文与A2不一致'
 else: raise AssertionError('Downstream accepted altered v3 capability evidence')
 adapted['fixed_pool']['rows'][0]['last']=456
 assert original['fixed_pool']['rows'][0]['last'] is None and sha256_json(transported)==transported_hash, 'Adaptation shared or mutated frozen evidence'
 changed=copy.deepcopy(frozen)
 changed['position_monitor']['positions'][0]['max_drawdown_from_peak_pct']=1
 try: _verify_packet(changed)
 except AgentFailure as exc: assert str(exc)=='Frozen evidence packet hash mismatch'
 else: raise AssertionError('TS accepted altered position evidence')
 if session=='REGULAR':
  from trading_os_v2.a1.state import position_snapshot_hash
  from trading_os_v2.agent_runtime.service import _verify_agent_output
  from trading_os_v2.risk.service import validate_position_management,enforce_d_plan,enforce_a3_final
  path=Path(folder)/'v2-runtime'/'a1'/'confirmed_positions.json'
  saved=path.read_bytes()
  stored=json.loads(saved)['positions'][0]
  assert position_snapshot_hash(stored)==frozen['position_monitor']['positions'][0]['position_snapshot_hash']
  # Exercise unchanged local output/risk validation without calling the model.
  fixture=runpy.run_path(str(v2/'tests'/'agent_runtime'/'test_ts_output_v2.py'))
  ts,context=fixture['ts_output']()
  for value in (ts,context):
   value['evidence_snapshot']['packet_hash']=frozen['packet_hash']
   value['evidence_snapshot']['run_id']=frozen['run_id']
  supplemental={'ts_report_context':context}
  _verify_supplemental(supplemental)
  _verify_agent_output(ts,'TS',evidence=frozen,supplemental=supplemental)
  for role in ('COMMITTEE','D','A3_REVIEW','A3'):
   _verify_agent_output({'contract_version':'v1','role':role},role,evidence=frozen,supplemental={})
  proposal={'contract_version':'v1','role':'D','action':'MANUAL_EXIT','underlying':'SPY','option_side':'call','expiration':'2026-09-11','strike':100,'quantity':2,'max_entry_debit':0,'stop_loss_pct':0,'take_profit_pct':0,'score':9}
  matched,violations=validate_position_management(proposal,frozen)
  assert matched and not violations
  d,violations=enforce_d_plan(proposal,frozen,ts)
  assert not violations and d['action']=='MANUAL_EXIT'
  final={**proposal,'role':'A3','decision':'MANUAL_EXIT'}
  final.pop('action')
  a3,violations=enforce_a3_final(final,frozen,ts,d,{})
  assert not violations and a3['decision']=='MANUAL_EXIT'
  rejected,violations=enforce_d_plan({**proposal,'quantity':3},frozen,ts)
  assert violations and rejected['action']=='NO_TRADE'
  rejected,violations=enforce_a3_final({**final,'quantity':3},frozen,ts,d,{})
  assert violations and rejected['decision']=='NO_TRADE'
  assert path.read_bytes()==saved, 'Downstream checks changed saved position identity'
 assert sha256_json(request)==before, 'A2 mutated its input evidence'
print('packet transport verified; tampering rejected')`;
  const command = resolve(import.meta.dirname, "../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const args = ["-B", "-"];
  const result = spawnSync(command, args, { cwd: resolve("."), input: code, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "packet transport verified; tampering rejected");
});
