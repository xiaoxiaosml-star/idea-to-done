/* 成事工坊 · 本地项目服务
 * 纯 Node 零依赖。职责: 伺服工作台页面 / 统一保存项目数据 / 调用 Claude Code 适配器。
 * 只监听 127.0.0.1; token 鉴权; Host/Origin 校验; 版本+冲突检查;
 * AI 等待期间允许并发写入,返回后基于最新状态合并(不覆盖新记录);
 * 原子写入,失败保留旧记录。健康检查不发起模型调用。
 */
const http=require('http');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const {callClaude}=require('./adapter');
const {parseProtocol,validExecution,validDecision}=require('./schemas');
const {normalizeInputs,ledger,summaryLines}=require('./trial');

const ROOT=process.env.CHENGSHI_ROOT||path.resolve(__dirname,'..');  /* 随包资源根 */
const APP=path.join(ROOT,'app');
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const PROJ=path.join(DATA,'projects');
/* 版本唯一真源 runtime/version.json, install/launcher 同读; 读不到才退回常量 */
const VERSION=(()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,'version.json'),'utf8')).version;}catch(_){return '0.1.5-stage4';}})();
/* 安装来源指纹: 本服务由哪个安装目录启动。launcher/install 核对它, 防止旧目录
 * 的同版本服务被新安装误当 own。归一化口径必须与 launcher/install 的 norm 一致。 */
const norm=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase();
const ROOT_FP=crypto.createHash('sha1').update(norm(ROOT)).digest('hex').slice(0,12);
const SKILL_CMD=process.env.CHENGSHI_SKILL||'/chengshi-workshop:idea-to-done';
fs.mkdirSync(PROJ,{recursive:true});
const DATA_FP=crypto.createHash('sha1').update(DATA).digest('hex').slice(0,12);

/* ---- 数据目录单写者锁(R01): 端口顺延会让第二个实例变成隐形双写者, 所以在监听前先原子
 * 取得数据目录级写权限。锁文件 = DATA/.writer.lock {pid,iid,port,root,data,nonce,startedAt}。
 * 已存在时核实持有者身份: 进程仍活着→明确退出并指回已确认服务; 进程已死但锁里端口仍有
 * 同 iid 的健康应答→持有者在(只是 pid 记录失真),不夺锁; 进程已死且无匹配健康应答→身份
 * 已灭可核实,原子替换回收。释放锁只认 nonce,绝不删掉别人的新锁。 */
const LOCK_FILE=path.join(DATA,'.writer.lock');
const lockNonce=crypto.randomBytes(8).toString('hex');
const lockContent=()=>{try{return JSON.parse(fs.readFileSync(LOCK_FILE,'utf8'));}catch(_){return null;}};
/* Windows 上对有短暂未关闭句柄的目标做 rename 会 EPERM(如另一进程刚读过、杀软扫描),
 * 属于毫秒级瞬态。统一带重试的原子替换: 重试仍失败才抛,调用方各按原子性语义处理。 */
function renameWithRetry(src,dst,tries,gap){
  tries=tries||6;gap=gap||120;
  let last=null;
  for(let i=0;i<tries;i++){
    try{fs.renameSync(src,dst);return;}
    catch(e){last=e;if(i<tries-1){
      const t=Date.now();while(Date.now()-t<gap);   /* 同步等待瞬态句柄释放, 不长于~1s */
    }}
  }
  throw last;
}
const pidAlive=p=>{if(!p||!Number.isInteger(p))return false;try{process.kill(p,0);return true;}catch(e){return e.code==='EPERM';}};
function probeHealth(pt){
  return new Promise(res=>{
    if(!pt)return res(null);
    const rq=http.get({host:'127.0.0.1',port:pt,path:'/api/health',timeout:1200},r=>{
      let b='';r.on('data',d=>b+=d);r.on('end',()=>{let j=null;try{j=JSON.parse(b);}catch(_){}res(j&&j.ok===true?j:null);});
    });
    rq.on('timeout',()=>{rq.destroy();res(null);});
    rq.on('error',()=>res(null));
  });
}
function releaseLock(){
  const c=lockContent();
  if(c&&c.nonce===lockNonce){try{fs.unlinkSync(LOCK_FILE);}catch(_){}}
}
async function acquireLock(){
  for(let attempt=0;attempt<3;attempt++){
    const payload={pid:process.pid,iid,port:port||0,root:ROOT_FP,data:DATA_FP,nonce:lockNonce,startedAt:new Date().toISOString()};
    try{
      const fd=fs.openSync(LOCK_FILE,'wx');
      fs.writeFileSync(fd,JSON.stringify(payload));
      fs.closeSync(fd);
      return true;
    }catch(e){
      if(e.code!=='EEXIST')return false;              /* 目录不可写等: 如实失败,不充当写者 */
      const c=lockContent();
      if(!c)continue;                                 /* 读到一半被删: 重试 */
      if(c.nonce===lockNonce)return true;             /* 本进程已持有(重入保护) */
      if(pidAlive(c.pid)){
        console.error('[成事工坊] 数据目录已被另一个成事工坊服务持有(pid '+c.pid
          +(c.port?'，http://127.0.0.1:'+c.port+'/':'')
          +')。同一数据目录只允许一个写者；本实例已退出，未读写任何数据。日常请直接打开上面的地址。');
        return false;
      }
      const h=await probeHealth(c.port);
      if(h&&h.iid===c.iid){
        console.error('[成事工坊] 数据目录的持有服务仍在应答(http://127.0.0.1:'+c.port
          +'/，实例 '+c.iid+')，只是锁里的 pid 记录已失真；不夺锁。本实例已退出，未读写任何数据。');
        return false;
      }
      /* 残留锁回收也要互斥提交(B1复审): 用一个回收许可文件(openSync 'wx' 原子创建,同 mkdir)。
       * 读到许可但身份缺失/不可读=别人正在占用(创建与写入之间的微窗口),绝不当残留删——
       * 只删"JSON完整且pid已死"的真残留(顺带30s老化兜底创建后崩溃的空白许可)。
       * 拿到许可后再重读 nonce 确认锁没换手,替换后再验证锁确实归自己,否则放弃。 */
      const CLAIM_FILE=LOCK_FILE+'.claim';
      const claimContent=()=>{try{return JSON.parse(fs.readFileSync(CLAIM_FILE,'utf8'));}catch(_){return null;}};
      const claimStale=()=>{try{return Date.now()-fs.statSync(CLAIM_FILE).mtimeMs>30000;}catch(_){return false;}};
      const takeClaim=()=>{
        for(let retry=0;retry<2;retry++){
          let fd=null;
          try{
            fd=fs.openSync(CLAIM_FILE,'wx');
            fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
            fs.closeSync(fd);
            return true;
          }catch(e){
            if(fd!==null){try{fs.closeSync(fd);}catch(_){}}
            if(e.code!=='EEXIST')return false;
            const cc=claimContent();
            if(cc&&pidAlive(cc.pid))return false;        /* 有别的进程正在回收,让给它 */
            if(!cc&&!claimStale())return false;          /* 占用中(写入微窗口/未知),不抢 */
            try{fs.unlinkSync(CLAIM_FILE);}catch(_){return false;}   /* 真残留才清 */
          }
        }
        return false;
      };
      const dropClaim=()=>{try{fs.unlinkSync(CLAIM_FILE);}catch(_){}};
      if(!takeClaim()){
        console.error('[成事工坊] 另一个实例正在回收这把崩溃残留锁，本实例退出，未读写任何数据。');
        return false;
      }
      try{
        const cur=lockContent();                      /* 持有回收许可后再核实: 锁没换手才替换 */
        if(!cur||cur.nonce!==c.nonce)return false;    /* 已由别人收走, 直接退出重试循环 */
        const tmp=LOCK_FILE+'.'+process.pid;
        fs.writeFileSync(tmp,JSON.stringify(payload));
        renameWithRetry(tmp,LOCK_FILE);               /* 原子替换;持有者已核实退出 */
        const now=lockContent();                      /* 替换后再验证: 锁确实归本进程 */
        if(!now||now.nonce!==lockNonce)return false;  /* 极端交错:别人后写覆盖,放弃不当写者 */
        console.log('[成事工坊] 已回收崩溃残留的数据目录锁(持有者进程不存在且无匹配服务应答)。');
        return true;
      }catch(err){
        console.error('[成事工坊] 回收残留锁时写入失败，本实例退出，未读写任何数据。('+String(err&&err.message||err)+')');
        return false;
      }
      finally{dropClaim();}
    }
  }
  console.error('[成事工坊] 无法取得数据目录写权限(锁核实重试耗尽)，本实例退出，未读写任何数据。');
  return false;
}
function updateLockPort(){
  const c=lockContent();
  if(c&&c.nonce===lockNonce){
    try{
      const tmp=LOCK_FILE+'.'+process.pid;
      fs.writeFileSync(tmp,JSON.stringify({...c,port}));
      renameWithRetry(tmp,LOCK_FILE);
    }catch(_){}
  }
}
process.on('exit',releaseLock);
process.on('SIGINT',()=>{releaseLock();process.exit(0);});
process.on('SIGTERM',()=>{releaseLock();process.exit(0);});

/* ---- 运行时状态(端口/token/实例指纹 重启复用) ----
 * iid=本数据目录的实例指纹: 首次启动生成, 之后不变。健康检查带它,
 * 安装器/启动器用它确认"应答的服务确实拥有这个数据目录", 不靠端口猜测。 */
let token,port,iid;
const rtFile=path.join(DATA,'runtime.json');
try{
  const rt=JSON.parse(fs.readFileSync(rtFile,'utf8'));
  token=rt.token;port=rt.port;iid=rt.iid;
}catch(_){ token=crypto.randomBytes(16).toString('hex');port=0; }
if(!iid)iid=crypto.randomBytes(8).toString('hex');

/* ---- 每事项写队列: 同步写入串行化; AI 合并段也走它,但不阻塞 await ---- */
const queues={};
function withLock(id,fn){
  const prev=queues[id]||Promise.resolve();
  const next=prev.then(fn,fn);
  queues[id]=next.catch(()=>{});
  return next;
}

/* ---- 同事项 AI 轮次互斥(R05): 讨论与复盘共用一把"模型轮次"锁。选用明确拒绝(409 ai-busy),
 * 不产生两个基于旧 session/base 并发的业务会话分支。锁只包模型调用周期,不阻止用户
 * 另存执行证据(executions/trials 不查此锁)。 */
const aiBusy={};

/* ---- 数据层 ---- */
const pid=id=>path.join(PROJ,id+'.json');
function loadProject(id){
  try{
    const p=JSON.parse(fs.readFileSync(pid(id),'utf8'));
    if(!Array.isArray(p.trials))p.trials=[];                 /* 旧数据补齐 */
    return p;
  }catch(_){return null;}
}
function saveProject(p){
  p.version=(p.version||0)+1;
  p.updatedAt=new Date().toISOString();
  const f=pid(p.id),tmp=f+'.tmp-'+process.pid+'-'+crypto.randomBytes(2).toString('hex');
  fs.writeFileSync(tmp,JSON.stringify(p,null,2),'utf8');
  renameWithRetry(tmp,f);                      /* 原子替换,失败时旧文件仍在 */
  return p;
}
function listProjects(){
  return fs.readdirSync(PROJ).filter(f=>f.endsWith('.json')).map(f=>{
    try{
      const p=JSON.parse(fs.readFileSync(path.join(PROJ,f),'utf8'));
      const next=p.plan&&p.plan.status==='confirmed'?'当前动作:'+p.plan.action
        :(p.planDraft?'有待确认草案(确认后生效)'
        :((p.executions&&p.executions.length)||(p.trials&&p.trials.length)?'已有实测记录,可带着结果复盘':'待讨论出第一个动作'));
      return {id:p.id,idea:p.idea,stage:p.stage,status:p.status,decision:p.decision||null,updatedAt:p.updatedAt,next};
    }catch(_){return null;}
  }).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
function newProject(idea,mode){
  const now=new Date().toISOString();
  return {id:'p'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),
    idea:idea.trim(),mode:mode||'discuss',stage:mode==='direct'?'execute':'discuss',
    status:'active',version:0,createdAt:now,updatedAt:now,
    discussion:[],plan:null,planDraft:null,planHistory:[],executions:[],trials:[],decision:null,sessionId:null};
}

/* ---- 提示词构建: 上下文 + 数据协议 + 明确任务 ---- */
function contextBlock(p){
  const L=[];
  L.push('【当前事项】\n念头：'+p.idea);
  if(p.plan){
    const pl=p.plan;
    L.push('【已确认计划(v'+pl.version+',当前执行中)】'
      +'\n要验证：'+pl.question+'\n动作：'+pl.action+'\n完成标准：'+pl.accept
      +'\n投入上限：'+pl.budget
      +(pl.budgetMoney!==null&&pl.budgetMoney!==undefined?'（钱 '+pl.budgetMoney+' 元）':'')
      +(pl.budgetTime!==null&&pl.budgetTime!==undefined?'（时间 '+pl.budgetTime+' 小时）':'')
      +'\n支持继续的信号：'+(pl.continueSignal||'（计划未写明，需向用户澄清）')
      +(pl.tool==='trial'?'\n适用工具：首次小生意验证单（本计划是面向陌生成交的小试，工作台会展开该工具）':'')
      +'\n停止条件：'+pl.stop+'\n要带回的证据：'+pl.evidenceToBring);
  }
  if(p.planDraft){
    const d=p.planDraft;
    L.push('【待确认新草案(v'+d.version+',尚未生效)】\n要验证：'+d.question+'\n动作：'+d.action
      +'\n完成标准：'+d.accept+'\n投入上限：'+d.budget
      +(d.budgetMoney!=null?'（钱 '+d.budgetMoney+' 元）':'')+(d.budgetTime!=null?'（时间 '+d.budgetTime+' 小时）':'')
      +'\n支持继续的信号：'+(d.continueSignal||'（未写明）')
      +'\n停止条件：'+d.stop+'\n要带回的证据：'+d.evidenceToBring
      +(d.reason?'\n说明：'+d.reason:''));
  }
  if(p.executions.length){
    L.push('【执行记录 · 按时间顺序,最后一条最新】\n'+p.executions.map((e,i)=>
      `${i+1}. [计划v${e.planVersion||0}] 动作:${e.action}｜实际投入:${e.input||'未填'}｜结果:${e.result||'未填'}\n   证据:${e.evidence||'未填'}${e.note?'｜备注:'+e.note:''}（${e.at.slice(0,10)}）`).join('\n'));
  }
  if(p.trials&&p.trials.length){
    const yuan=c=>(c/100).toFixed(2);
    /* 原始实测必须完整带(空=未填, 与0区分); 三笔账摘要只是补充, 缺项不能遮掉其他已知事实 */
    const raw=t=>{
      const q=t.inputs,n=t.nums;
      const money=k=>n[k]===null?'未填':yuan(n[k]);
      const cnt=k=>n[k]===null?'未填':n[k];
      return '原始实测：触达 '+cnt('r1')+' 人｜成交 '+cnt('r2')+' 单｜营业额 '+money('r3')+' 元｜已售成本 '+money('r4')
        +' 元｜其他费用 '+money('r5')+' 元｜投入时间 '+(n.r6===null?'未填':(n.r6/100))+' 小时｜实际收到 '+money('r7')
        +' 元｜实际支付 '+money('r8')+' 元｜剩余库存 '+money('r9')+' 元';
    };
    L.push('【首次小生意验证单 · 实测记录,按时间顺序】\n'+p.trials.map((t,i)=>{
      const q=t.inputs;
      return `${i+1}. [计划v${t.planVersion||0}·${t.at.slice(0,10)}]\n   验证什么:${q.q1||'未填'}｜最多投入:${t.nums.q2a!==null?yuan(t.nums.q2a):'?'} 元 / ${t.nums.q2b!==null?yuan(t.nums.q2b):'?'} 小时\n   支持继续的信号:${q.q3||'（未填）'}｜停止条件:${q.q4||'未填'}\n   ${raw(t)}\n   这周动作:${q.c1||'未填'}｜结果数字:${q.c2||'未填'}｜结论:${q.c3||'未填'}\n   三笔账：\n   ${t.lines.join('\n   ')}`;
    }).join('\n'));
  }
  if(p.decision)L.push('【当前结局决定】'+({done:'达成',go:'继续验证',pause:'暂停',stop:'终止'})[p.decision.type]+'：'+p.decision.reason);
  if(p.discussion&&p.discussion.length){
    /* 讨论历史进上下文(B4复审): 重建/续谈都以它捡起用户明说过的约束(如时间限制、边界),
     * 不静默丢。用户消息全量带; AI 回复截断到头部, 超长只带最近一段, 防止提示词膨胀。 */
    const msgs=p.discussion;
    const tail=msgs.length>30?msgs.slice(msgs.length-30):msgs;
    L.push('【讨论记录(用户说过的话全部算数,尤其是明确约束,继续讨论必须全部遵守)】\n'+tail.map(m=>
      (m.role==='user'?'用户：':'AI：')+(m.role==='user'?String(m.text):String(m.text).slice(0,400))).join('\n'));
  }
  if(p.planHistory&&p.planHistory.length)
    L.push('【历史计划版本(仅留档,均不再执行)】\n'+p.planHistory.map(h=>
      'v'+h.version+'（'+(h.archiveReason||'已替换')+'，止于 '+String(h.archivedAt||'').slice(0,10)+'）'
      +'\n要验证：'+(h.question||'未填')+'｜动作：'+(h.action||'未填')+'｜停止条件：'+(h.stop||'未填')).join('\n'));
  return L.join('\n\n');
}
const CONTRACT=`【运行环境】你在「成事工坊」本地工作台里被调用，讨论只围绕上面这一件事。不要使用或读取任何个人记忆文件；需要方法细节时，只读安装目录下的 chapters/、deep-dive/、tools/（已授权）。
【纪律】区分事实与假设，不把假设记成事实；不凭聊天判断市场已可行；计划草案必须等用户在网页上确认后才生效，你不替用户确认计划或结局；不要改动或撤销用户已确认的计划。
【定位器】需要给念头定方向时，读 chapters/附-道法术器_念头定位.md 做四层定位：道层(政策/法律/税务/平台规则/自然规律/信仰)有一票否决的硬伤就直接建议停、不进计划，拿不准的标"待核实"给用户检索词自查，不把未知包装成事实；其余情况只指出当前最薄的一层，不要求各层齐全。法层"谁付钱、为什么付"只对商业事项问（小生意/副业/收费服务）；非商业事项（备考、求职、搬家、学技能等）通用检查只问目标、约束、下一步、证据。一条变现路径走不通=建议换路径或调整模式，不因此否决整个目标；只有道层硬伤才建议停。出计划时说明本计划主要补哪层；复盘时对照回答这轮补足了哪层、还缺哪层。
【数据协议】每一轮都是独立回复：不要复述之前轮次说过的内容，只回应当前任务与最新信息。正文写给用户看，语气直接、少客套。正文之后必须另起一行输出且只输出一个 fenced code block（以三个反引号加 json 开头、以三个反引号结尾，块不完整视为接口故障），内容只含以下三种之一，不要输出任何其他 JSON 块：
{"type":"questions","items":["当前最影响判断的问题"]}            —— 信息不足以出计划时
{"type":"plan","question":"本计划要验证什么","action":"具体动作(能今天就开干的)","accept":"做到什么程度算完","budget":"投入上限(时间/钱,写数字)","stop":"出现什么结果该停","evidenceToBring":"要带回的证据","budgetMoney":100,"budgetTime":2,"continueSignal":"出现什么实测结果支持继续","tool":"trial"}  —— 信息足够时；这只会成为待确认草案，不会自动替换已确认计划。budgetMoney=钱上限(元,纯数字)、budgetTime=时间上限(小时,纯数字)：写得出确定数字才填，写不出就省略字段，不许猜；continueSignal=支持继续的实测信号，必须区别于 accept（完成只证明动作做完，不代表生意值得继续），想清楚再填；tool 仅当本计划是面向陌生成交的小生意小试（要记录触达/成交/营业额/成本来算利润账）时才带 "trial"，其他事项一律省略该字段，让工作台按显式标记展开验证单工具
{"type":"review","result":"实际结果对照事前标准","assumptionDelta":"原假设获得或失去的支持","stillUnknown":"仍未知的部分","next":"建议的下一步(必填)","suggest":"continue|adjust|pause|stop"}  —— 复盘时`;

function discussPrompt(p,userText){
  return SKILL_CMD+'\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【用户刚说的话】\n'+userText
    +'\n\n【本次任务】'+(p.stage==='execute'
      ?'用户已在执行或刚补充了情况。若信息足够给出下一轮计划草案，否则先问最关键的补充问题。'
      :'这是本事项的开场讨论。先澄清事实、假设、未知项与投入边界；信息不足以出计划时，问当前最影响判断的问题（不超过3个）；足够时直接给计划草案。');
}
function execHasReal(e){return !!(e&&(e.result&&e.result.trim())||(e.evidence&&e.evidence.trim()));}
/* 验证单算实测证据(R06/N2复审): 区分准备、实际行动、观察到的结果。
 * 任一实测字段(r1-r9)已填即算——合法的 0 单/0 收入也是观察,不用真假值把 0 当没填;
 * 只填动作(c1"明天准备去做")或事前条件(q1-q4)不算实测;结果数字(c2)算;
 * 结论/下一步(c3)只是判断文字,不能单独等价于观察到的结果(N2)。 */
function trialHasReal(t){
  if(!t)return false;
  if(t.nums&&['r1','r2','r3','r4','r5','r6','r7','r8','r9'].some(k=>t.nums[k]!==null&&t.nums[k]!==undefined))return true;
  const q=t.inputs||{};
  return !!(q.c2&&String(q.c2).trim());
}
function reviewPrompt(p){
  /* 统一证据时间线: 执行记录与验证单都能发起复盘, 以最新一条为本次复盘对象 */
  const items=[
    ...p.executions.filter(execHasReal).map(e=>({kind:'exec',at:e.at,ref:e})),
    ...(p.trials||[]).filter(trialHasReal).map(t=>({kind:'trial',at:t.at,ref:t}))
  ].sort((a,b)=>a.at.localeCompare(b.at));
  const latest=items[items.length-1];
  const yuan=c=>(c/100).toFixed(2);
  let focus='';
  if(latest.kind==='exec'){
    const e=latest.ref;
    focus='最新实测（执行记录·关联计划v'+(e.planVersion||0)+'·'+e.at.slice(0,10)+'）：'
      +'\n动作：'+e.action+'\n实际投入：'+(e.input||'未填')+'\n结果：'+(e.result||'未填')
      +'\n证据：'+(e.evidence||'未填')+(e.note?'\n用户备注：'+e.note:'');
  }else{
    const t=latest.ref,q=t.inputs,n=t.nums;
    const money=k=>n[k]===null?'未填':yuan(n[k])+' 元';
    focus='最新实测（首次小生意验证单·关联计划v'+(t.planVersion||0)+'·'+t.at.slice(0,10)+'）：'
      +'\n验证什么：'+(q.q1||'未填')
      +'\n判断条件：支持继续=「'+(q.q3||'未填')+'」；停止=「'+(q.q4||'未填')+'」'
      +'\n原始输入：触达 '+(n.r1===null?'未填':n.r1)+' 人，成交 '+(n.r2===null?'未填':n.r2)+' 单，营业额 '+money('r3')
      +'，已售成本 '+money('r4')+'，其他费用 '+money('r5')+'，投入时间 '+(n.r6===null?'未填':(n.r6/100))+' 小时'
      +'，实际收到 '+money('r7')+'，实际支付 '+money('r8')+'，剩余库存 '+money('r9')
      +'\n三笔账：\n'+t.lines.join('\n')
      +'\n这周动作：'+(q.c1||'未填')+'｜结果数字：'+(q.c2||'未填')+'｜结论：'+(q.c3||'未填');
  }
  const rest=items.slice(0,-1).length;
  return SKILL_CMD+'\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【本次任务】复盘。请针对下面这条最新实测记录做对照复盘，不要重复之前的回答：'
    +'\n'+focus
    +(rest?'（另有 '+rest+' 条较早实测记录见上方上下文，一并参考，但以上面这条为重点）':'')
    +'\n逐条对照事前标准、投入上限与停止条件（含验证单里用户自己写的判断条件），'
    +'结合实测数字给出复盘建议；不要只重复账面数字，要判断对照停止/继续条件后该继续、调整、暂停还是停止。'
    +'给出 review 协议块（next 与 suggest 必填）。';
}

/* ---- HTTP 层 ---- */
function send(res,code,obj){
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}
function readBody(req){
  return new Promise((ok,no)=>{
    let s='';let n=0;
    req.on('data',d=>{n+=d.length;if(n>1e6){req.destroy();no(new Error('body-too-large'));}s+=d;});
    req.on('end',()=>{try{ok(s?JSON.parse(s):{});}catch(e){no(new Error('bad-json'));}});
    req.on('error',no);
  });
}

/* 只伺服工作台白名单资源; 真实包含关系校验 */
function serveStatic(res,urlPath){
  if(urlPath==='/'||urlPath==='/index.html'){
    let html=fs.readFileSync(path.join(APP,'index.html'),'utf8');
    html=html.split('__TOKEN__').join(token).split('__PORT__').join(String(port));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(html);
  }
  const rel=decodeURIComponent(urlPath.replace(/^\//,''));
  const full=path.resolve(APP,rel);
  const rel2=path.relative(APP,full);
  if(rel2.startsWith('..')||path.isAbsolute(rel2)||!fs.existsSync(full)||!fs.statSync(full).isFile())
    return send(res,404,{error:'not-found'});
  const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'application/octet-stream'});
  fs.createReadStream(full).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  const P=u.pathname;
  try{
    /* 回环来源校验: Host 必须本机; 带 Origin 时必须本机来源 */
    const host=req.headers.host||'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host))return send(res,403,{error:'bad-host'});
    const origin=req.headers.origin;
    if(origin&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin))return send(res,403,{error:'bad-origin'});

    if(P==='/api/health')return send(res,200,{ok:true,version:VERSION,service:'chengshi-workshop',data:crypto.createHash('sha1').update(DATA).digest('hex').slice(0,12),iid,root:ROOT_FP,pid:process.pid});
    /* 独立工具页面: 只放行 tools/ 下文件名安全且存在的 html,不变成任意本机文件读取 */
    if(P.startsWith('/tool/')){
      const name=decodeURIComponent(P.slice(6));
      if(!/^[\w一-鿿-]+\.html$/.test(name))return send(res,404,{error:'not-found'});
      const full=path.join(ROOT,'tools',name);
      if(!fs.existsSync(full)||!fs.statSync(full).isFile())return send(res,404,{error:'not-found'});
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return fs.createReadStream(full).pipe(res);
    }
    if(!P.startsWith('/api/'))return serveStatic(res,P);
    if(req.headers['x-chengshi-token']!==token)return send(res,401,{error:'unauthorized'});
    const parts=P.split('/').filter(Boolean);
    const body=['POST','PUT'].includes(req.method)?await readBody(req):{};

    /* 方法与示例目录(R10): 显式分组的主线/深潜手册/案例/工具表,研究旧稿、AGENTS、
     * 维护文件不进目录。methods 为全量扁平数组,保持旧客户端可用。 */
    if(P==='/api/methods'){
      const mdDir=d=>{const full=path.join(ROOT,d);return fs.existsSync(full)
        ?fs.readdirSync(full).filter(f=>f.endsWith('.md')).sort().map(f=>({path:d.replace(/\\/g,'/')+'/'+f,title:f.replace(/\.md$/,'')}))
        :[];};
      const caseItems=[...mdDir('cases')];
      const dc=path.join(ROOT,'deep-dive','cases');
      if(fs.existsSync(dc))for(const sub of fs.readdirSync(dc).sort()){
        const sd=path.join(dc,sub);
        if(fs.statSync(sd).isDirectory())
          for(const f of fs.readdirSync(sd).filter(f=>f.endsWith('.md')).sort())
            caseItems.push({path:'deep-dive/cases/'+sub+'/'+f,title:sub+'/'+f.replace(/\.md$/,'')});
      }
      const groups=[
        {key:'main',label:'主线 · 第零步 + 五编',items:mdDir('chapters')},
        {key:'handbook',label:'深潜 ·《从一个念头到一门生意》19 章手册',items:mdDir('deep-dive/handbook')},
        {key:'cases',label:'案例库（真实复盘收稿中 + 演算示例）',items:caseItems},
        {key:'tooltables',label:'深潜 · 29 张工具表',items:mdDir('deep-dive/tools')},
        {key:'tooldoc',label:'独立工具说明',items:[{path:'tools/README.md',title:'工具箱总览'}]}
      ];
      return send(res,200,{groups,methods:groups.flatMap(g=>g.items)});
    }
    /* 正文接口: 只服务约定公开内容(白名单根 + 相对路径校验),越界/非 md/不存在一律 404 */
    if(P==='/api/methods/content'){
      const rel=(u.searchParams.get('p')||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+/g,'/');
      const allowed=/^(chapters\/[^/]+\.md|deep-dive\/handbook\/[^/]+\.md|deep-dive\/tools\/[^/]+\.md|deep-dive\/cases\/[^/]+\/[^/]+\.md|cases\/[^/]+\.md|tools\/README\.md)$/;
      if(!allowed.test(rel))return send(res,404,{error:'not-found'});
      const full=path.resolve(ROOT,rel);
      const rel2=path.relative(ROOT,full);
      if(rel2.startsWith('..')||path.isAbsolute(rel2)||!fs.existsSync(full))
        return send(res,404,{error:'not-found'});
      return send(res,200,{content:fs.readFileSync(full,'utf8')});
    }
    if(P==='/api/projects'&&req.method==='GET')return send(res,200,{projects:listProjects()});
    if(P==='/api/projects'&&req.method==='POST'){
      if(!body.idea||!body.idea.trim())return send(res,400,{error:'idea-required'});
      const p=saveProject(newProject(body.idea,body.mode));
      return send(res,200,{project:p});
    }
    if(parts[0]==='api'&&parts[1]==='projects'&&parts[2]){
      const id=parts[2];
      /* 所有写接口必须带明确 base */
      const needBase=p=>{
        if(body.base===undefined||body.base===null)return send(res,400,{error:'base-required'}),null;
        if(body.base!==p.version)return send(res,409,{error:'conflict',current:p.version}),null;
        return true;
      };

      if(parts.length===3&&req.method==='GET'){
        const p=loadProject(id);
        if(!p)return send(res,404,{error:'not-found'});
        return send(res,200,{project:p});
      }

      /* 讨论/回答: 入口查base;同事项 AI 轮次互斥(拒绝式,不产生双会话分支);AI返回后基于最新状态合并,绝不回写旧快照 */
      if(parts[3]==='messages'&&req.method==='POST'){
        if(!body.text||!body.text.trim())return send(res,400,{error:'text-required'});
        const entry=loadProject(id);
        if(!entry)return send(res,404,{error:'not-found'});
        if(!needBase(entry))return;
        if(aiBusy[id])return send(res,409,{error:'ai-busy'});
        aiBusy[id]=true;
        try{
        /* 真正开始前重查版本与会话: 以调用发起瞬间的最新状态为准 */
        const pre=loadProject(id)||entry;
        const entryVersion=pre.version;
        const callStart=new Date().toISOString();
        const userMsg={role:'user',text:body.text.trim(),at:callStart};
        const r=await callClaude({prompt:discussPrompt(pre,body.text.trim()),sessionId:pre.sessionId,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){
          /* 失败: 不落任何写,并发期间的其他修改原样保留; 会话失效给前端重建入口 */
          const cur=loadProject(id);
          const lost=/session|conversation|resume/i.test(String(r.error||''));
          return send(res,502,{error:'ai-call-failed',detail:r.error,project:cur,sessionLost:lost});
        }
        const proto=parseProtocol(r.text);
        const aiMsg={role:'ai',text:r.text,at:new Date().toISOString(),cost:r.costUsd,
          protocol:proto.ok?{type:proto.type,...proto.data}:null,
          protoError:proto.ok?undefined:proto.error};
        const merged=await withLock(id,()=>{                    /* 短临界区: 合并到最新状态 */
          const F=loadProject(id);
          F.discussion.push(userMsg,aiMsg);
          F.sessionId=r.sessionId||F.sessionId;
          if(proto.ok&&proto.type==='plan'){
            /* 草案不触碰已确认计划; 覆盖旧草案须无妨,但保留痕迹。
             * 用户在等待期间手写的较新草案优先,AI 旧响应不得倒回覆盖(R05/T19) */
            const newerUserDraft=F.planDraft&&F.planDraft.createdAt&&F.planDraft.createdAt>callStart&&F.planDraft.author==='user';
            if(!newerUserDraft){
              if(F.planDraft)F.planHistory.push({...F.planDraft,archivedAt:new Date().toISOString(),archiveReason:'被新草案替换'});
              F.planDraft={...proto.data,version:F.plan?F.plan.version+1:1,author:'ai',createdAt:new Date().toISOString()};
            }
          }
          if(F.version!==entryVersion)aiMsg.stale=true;          /* AI期间有人改过数据,复盘基于稍早状态 */
          saveProject(F);
          return F;
        });
        return send(res,200,{project:merged,ai:{callOk:true,protocolOk:proto.ok,protocol:proto.ok?{type:proto.type,...proto.data}:null,error:proto.ok?undefined:proto.error}});
        }finally{aiBusy[id]=false;}
      }

      /* 确认草案 → 成为执行计划(替换已确认计划时须给理由,旧版留档) */
      if(parts[3]==='plan'&&parts[4]==='confirm'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          if(!F.planDraft){send(res,400,{error:'no-draft'});return null;}
          if(F.plan&&F.plan.status==='confirmed'&&!(body.reason&&body.reason.trim())){
            send(res,400,{error:'reason-required-to-replace-confirmed-plan'});return null;}
          if(F.plan)F.planHistory.push({...F.plan,archivedAt:new Date().toISOString(),
            archiveReason:(body.reason||'').trim()||'被新计划替换'});
          F.plan={...F.planDraft,status:'confirmed',confirmedAt:new Date().toISOString()};
          F.planDraft=null;
          F.stage='execute';
          return saveProject(F);
        });
        if(result)return send(res,200,{project:result});
        return;                                                  /* 错误响应已由分支回写 */
      }

      /* 手写/修改草案(生成或更新 planDraft,不直接动已确认计划) */
      if(parts[3]==='plan'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          const need=['question','action','accept','budget','stop','evidenceToBring'];
          if(need.some(k=>!body[k]||!body[k].trim()))return send(res,400,{error:'plan-fields-required'}),null;
          const numOrNull=v=>{
            if(v===undefined||v===null||v==='')return null;
            const n2=Number(v);
            return isFinite(n2)&&n2>=0?n2:null;
          };
          const bm=numOrNull(body.budgetMoney),bt=numOrNull(body.budgetTime);
          if((body.budgetMoney!==undefined&&body.budgetMoney!==null&&body.budgetMoney!=='')&&bm===null)
            return send(res,400,{error:'bad-budgetMoney'}),null;
          if((body.budgetTime!==undefined&&body.budgetTime!==null&&body.budgetTime!=='')&&bt===null)
            return send(res,400,{error:'bad-budgetTime'}),null;
          if(body.tool!==undefined&&body.tool!==null&&body.tool!==''&&body.tool!=='trial')
            return send(res,400,{error:'bad-tool'}),null;
          if(F.planDraft)F.planHistory.push({...F.planDraft,archivedAt:new Date().toISOString(),archiveReason:body.reason||'草案被修改'});
          F.planDraft={question:body.question.trim(),action:body.action.trim(),accept:body.accept.trim(),
            budget:body.budget.trim(),stop:body.stop.trim(),evidenceToBring:body.evidenceToBring.trim(),
            budgetMoney:bm,budgetTime:bt,
            continueSignal:(body.continueSignal||'').trim(),
            tool:body.tool==='trial'?'trial':'',
            reason:(body.reason||'').trim(),version:F.plan?F.plan.version+1:1,
            author:body.author==='user'?'user':'ai',createdAt:new Date().toISOString()};
          return saveProject(F);
        });
        if(!result)return;                                       /* needBase/校验已回包 */
        return send(res,200,{project:result});
      }

      /* 执行记录(证据)。默认关联当前已确认计划版本;支持显式 planVersion 补记历史版本,
       * 只接受当前或历史留档版本,非法/不存在即拒,旧记录不静默重标(R06) */
      if(parts[3]==='executions'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          if(!body.action||!body.action.trim())return send(res,400,{error:'action-required'}),null;
          const curVer=F.plan&&F.plan.status==='confirmed'?F.plan.version:0;
          let planVer=curVer;
          if(body.planVersion!==undefined&&body.planVersion!==null&&body.planVersion!==''){
            const pv=Number(body.planVersion);
            const histVers=(F.planHistory||[]).map(h=>h.version);
            if(!Number.isInteger(pv)||(pv!==curVer&&!histVers.includes(pv))){
              send(res,400,{error:'bad-plan-version',current:curVer});return null;
            }
            planVer=pv;
          }
          const e={id:'e'+Date.now().toString(36)+crypto.randomBytes(2).toString('hex'),
            action:body.action.trim(),input:(body.input||'').trim(),result:(body.result||'').trim(),
            evidence:(body.evidence||'').trim(),note:(body.note||'').trim(),
            planVersion:planVer,
            at:new Date().toISOString()};
          if(!validExecution(e))return send(res,400,{error:'bad-execution'}),null;
          F.executions.push(e);
          return saveProject(F);
        });
        if(!result)return;
        return send(res,200,{project:result,execution:result.executions[result.executions.length-1]});
      }

      /* 首次小生意验证单: 保存实测输入+服务端计算三笔账。
       * planVersion 可由页面显式携带(草稿基于旧计划时), 只允许=当前已确认版本或历史留档版本, 杜绝静默贴错版本 */
      if(parts[3]==='trials'&&req.method==='POST'){
        const n=normalizeInputs(body.inputs);
        if(!n.ok)return send(res,400,{error:n.error});
        const L=ledger(n.nums);
        const sum=summaryLines(n.inputs,n.nums,L);
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          const curVer=F.plan&&F.plan.status==='confirmed'?F.plan.version:0;
          let planVer=curVer;
          if(body.planVersion!==undefined&&body.planVersion!==null&&body.planVersion!==''){
            const pv=Number(body.planVersion);
            const histVers=(F.planHistory||[]).map(h=>h.version);
            if(!Number.isInteger(pv)||(pv!==curVer&&!histVers.includes(pv))){
              send(res,400,{error:'bad-plan-version',current:curVer});return null;
            }
            planVer=pv;
          }
          const t={id:'t'+Date.now().toString(36)+crypto.randomBytes(2).toString('hex'),
            planVersion:planVer,
            inputs:n.inputs,nums:n.nums,lines:sum.lines,ledger:L,
            at:new Date().toISOString()};
          F.trials.push(t);
          saveProject(F);
          return t;
        });
        if(!result)return;
        return send(res,200,{project:loadProject(id),trial:result});
      }

      /* 带着最新证据续谈复盘: 只接受合法 review 协议才计入"已复盘"。
       * R04: 有合法计划+真实证据时允许首次复盘直接创建会话,不要求先聊一句;
       * R05: 与讨论共用 AI 轮次互斥;真正开始前重查版本与会话。 */
      if(parts[3]==='review'&&req.method==='POST'){
        const entry=loadProject(id);
        if(!entry)return send(res,404,{error:'not-found'});
        if(!needBase(entry))return;
        if(aiBusy[id])return send(res,409,{error:'ai-busy'});
        const hasReal=entry.executions.some(execHasReal)||(entry.trials||[]).some(trialHasReal);
        if(!hasReal)return send(res,400,{error:'no-real-evidence',project:entry,
          hint:'还没有可对照的实测结果。先回「执行」面板补上真实结果（合法的 0 单/0 收入也算观察），再点复盘。'});
        aiBusy[id]=true;
        try{
        const pre=loadProject(id)||entry;
        const entryVersion=pre.version;
        /* sessionId 为空=首次复盘: 不带 --resume,Claude 会创建新会话,上下文由 reviewPrompt 全量带入 */
        const r=await callClaude({prompt:reviewPrompt(pre),sessionId:pre.sessionId||undefined,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){
          const cur=loadProject(id);
          const lost=/session|conversation|resume/i.test(String(r.error||''));
          return send(res,502,{error:'ai-call-failed',detail:r.error,project:cur,sessionLost:lost});
        }
        const proto=parseProtocol(r.text);
        const isReview=proto.ok&&proto.type==='review';
        const merged=await withLock(id,()=>{
          const F=loadProject(id);
          F.discussion.push({role:'ai',text:r.text,at:new Date().toISOString(),cost:r.costUsd,kind:'review',
            protocol:isReview?{type:'review',...proto.data}:null,
            protoError:isReview?undefined:(proto.ok?('unexpected-type:'+proto.type):proto.error),
            stale:F.version!==entryVersion});
          F.sessionId=r.sessionId||F.sessionId;             /* 首次复盘的会话从这里接上 */
          if(isReview)F.stage='review';
          return saveProject(F);
        });
        return send(res,200,{project:merged,ai:{callOk:true,protocolOk:isReview,
          protocol:isReview?{type:'review',...proto.data}:null,
          error:isReview?undefined:(proto.ok?('unexpected-type:'+proto.type):proto.error)}});
        }finally{aiBusy[id]=false;}
      }

      /* 会话失效后的显式重建(R05/B4复审): 用户确认后清空 sessionId,下一次调用以
       * contextBlock 里的讨论记录(用户明说约束全量带)、已确认计划、历史计划正文和全部证据
       * 开新会话,不静默丢约束;不替用户发起任何模型调用。 */
      if(parts[3]==='session'&&parts[4]==='rebuild'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          F.sessionId=null;
          return saveProject(F);
        });
        if(!result)return;
        return send(res,200,{project:result,rebuilt:true});
      }

      /* 结局决定(用户确认动作,任何时候可记) */
      if(parts[3]==='decision'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          if(!['done','go','pause','stop'].includes(body.type))return send(res,400,{error:'bad-decision-type'}),null;
          const d={type:body.type,reason:(body.reason||'').trim(),at:new Date().toISOString(),version:F.version};
          if(!validDecision(d))return send(res,400,{error:'bad-decision'}),null;
          F.decision=d;F.status=body.type==='go'?'active':body.type;
          return saveProject(F);
        });
        if(!result)return;
        return send(res,200,{project:result});
      }
    }
    send(res,404,{error:'not-found'});
  }catch(e){
    send(res,500,{error:'server-error',detail:String(e.message||e).slice(0,200)});
  }
});

/* ---- 启动: 先原子取得数据目录单写者锁(R01),拿不到就明确退出,绝不监听写数据 ---- */
function start(){
  const tryListen=(pt,left)=>{
    server.once('error',err=>{
      if(err.code==='EADDRINUSE'&&left>0)return tryListen(pt+1,left-1);
      releaseLock();
      console.error('[成事工坊] 端口占用,启动失败:',err.message);process.exit(1);
    });
    server.listen(pt,'127.0.0.1',()=>{
      port=pt;
      updateLockPort();
      fs.writeFileSync(rtFile,JSON.stringify({token,port,pid:process.pid,version:VERSION,iid,root:ROOT},null,2));
      console.log('[成事工坊] 本地服务已启动:');
      console.log('  工作台  http://127.0.0.1:'+pt+'/');
      console.log('  数据目录 '+DATA);
      console.log('  停止    Ctrl+C');
    });
  };
  acquireLock().then(ok=>{
    if(!ok){process.exitCode=1;return process.exit(1);}
    tryListen(port||4310,20);
  });
}
start();
