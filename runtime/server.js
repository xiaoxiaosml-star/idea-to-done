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

const ROOT=process.env.CHENGSHI_ROOT||path.resolve(__dirname,'..');  /* 随包资源根 */
const APP=path.join(ROOT,'app');
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const PROJ=path.join(DATA,'projects');
const VERSION='0.1.1-stage1';
const SKILL_CMD=process.env.CHENGSHI_SKILL||'/chengshi-workshop:idea-to-done';
fs.mkdirSync(PROJ,{recursive:true});

/* ---- 运行时状态(端口/token 重启复用) ---- */
let token,port;
const rtFile=path.join(DATA,'runtime.json');
try{
  const rt=JSON.parse(fs.readFileSync(rtFile,'utf8'));
  token=rt.token;port=rt.port;
}catch(_){ token=crypto.randomBytes(16).toString('hex');port=0; }

/* ---- 每事项写队列: 同步写入串行化; AI 合并段也走它,但不阻塞 await ---- */
const queues={};
function withLock(id,fn){
  const prev=queues[id]||Promise.resolve();
  const next=prev.then(fn,fn);
  queues[id]=next.catch(()=>{});
  return next;
}

/* ---- 数据层 ---- */
const pid=id=>path.join(PROJ,id+'.json');
function loadProject(id){
  try{return JSON.parse(fs.readFileSync(pid(id),'utf8'));}catch(_){return null;}
}
function saveProject(p){
  p.version=(p.version||0)+1;
  p.updatedAt=new Date().toISOString();
  const f=pid(p.id),tmp=f+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(p,null,2),'utf8');
  fs.renameSync(tmp,f);                        /* 原子替换,失败时旧文件仍在 */
  return p;
}
function listProjects(){
  return fs.readdirSync(PROJ).filter(f=>f.endsWith('.json')).map(f=>{
    try{
      const p=JSON.parse(fs.readFileSync(path.join(PROJ,f),'utf8'));
      return {id:p.id,idea:p.idea,stage:p.stage,status:p.status,decision:p.decision||null,updatedAt:p.updatedAt};
    }catch(_){return null;}
  }).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
function newProject(idea,mode){
  const now=new Date().toISOString();
  return {id:'p'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'),
    idea:idea.trim(),mode:mode||'discuss',stage:mode==='direct'?'execute':'discuss',
    status:'active',version:0,createdAt:now,updatedAt:now,
    discussion:[],plan:null,planDraft:null,planHistory:[],executions:[],decision:null,sessionId:null};
}

/* ---- 提示词构建: 上下文 + 数据协议 + 明确任务 ---- */
function contextBlock(p){
  const L=[];
  L.push('【当前事项】\n念头：'+p.idea);
  if(p.plan){
    const pl=p.plan;
    L.push('【已确认计划(v'+pl.version+',当前执行中)】'
      +'\n要验证：'+pl.question+'\n动作：'+pl.action+'\n完成标准：'+pl.accept
      +'\n投入上限：'+pl.budget+'\n停止条件：'+pl.stop+'\n要带回的证据：'+pl.evidenceToBring);
  }
  if(p.planDraft){
    const d=p.planDraft;
    L.push('【待确认新草案(v'+d.version+',尚未生效)】\n要验证：'+d.question+'\n动作：'+d.action
      +'\n完成标准：'+d.accept+'\n投入上限：'+d.budget+'\n停止条件：'+d.stop+'\n要带回的证据：'+d.evidenceToBring
      +(d.reason?'\n说明：'+d.reason:''));
  }
  if(p.executions.length){
    L.push('【执行记录 · 按时间顺序,最后一条最新】\n'+p.executions.map((e,i)=>
      `${i+1}. [计划v${e.planVersion||0}] 动作:${e.action}｜实际投入:${e.input||'未填'}｜结果:${e.result||'未填'}\n   证据:${e.evidence||'未填'}${e.note?'｜备注:'+e.note:''}（${e.at.slice(0,10)}）`).join('\n'));
  }
  if(p.decision)L.push('【当前结局决定】'+({done:'达成',go:'继续验证',pause:'暂停',stop:'终止'})[p.decision.type]+'：'+p.decision.reason);
  return L.join('\n\n');
}
const CONTRACT=`【运行环境】你在「成事工坊」本地工作台里被调用，讨论只围绕上面这一件事。不要使用或读取任何个人记忆文件；需要方法细节时，只读安装目录下的 chapters/、deep-dive/、tools/（已授权）。
【纪律】区分事实与假设，不把假设记成事实；不凭聊天判断市场已可行；计划草案必须等用户在网页上确认后才生效，你不替用户确认计划或结局；不要改动或撤销用户已确认的计划。
【数据协议】每一轮都是独立回复：不要复述之前轮次说过的内容，只回应当前任务与最新信息。正文写给用户看，语气直接、少客套。正文之后必须另起一行输出且只输出一个 fenced code block（以三个反引号加 json 开头、以三个反引号结尾，块不完整视为接口故障），内容只含以下三种之一，不要输出任何其他 JSON 块：
{"type":"questions","items":["当前最影响判断的问题"]}            —— 信息不足以出计划时
{"type":"plan","question":"本计划要验证什么","action":"具体动作(能今天就开干的)","accept":"做到什么程度算完","budget":"投入上限(时间/钱,写数字)","stop":"出现什么结果该停","evidenceToBring":"要带回的证据"}  —— 信息足够时；这只会成为待确认草案，不会自动替换已确认计划
{"type":"review","result":"实际结果对照事前标准","assumptionDelta":"原假设获得或失去的支持","stillUnknown":"仍未知的部分","next":"建议的下一步(必填)","suggest":"continue|adjust|pause|stop"}  —— 复盘时`;

function discussPrompt(p,userText){
  return SKILL_CMD+'\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【用户刚说的话】\n'+userText
    +'\n\n【本次任务】'+(p.stage==='execute'
      ?'用户已在执行或刚补充了情况。若信息足够给出下一轮计划草案，否则先问最关键的补充问题。'
      :'这是本事项的开场讨论。先澄清事实、假设、未知项与投入边界；信息不足以出计划时，问当前最影响判断的问题（不超过3个）；足够时直接给计划草案。');
}
function reviewPrompt(p){
  const latest=p.executions[p.executions.length-1];
  return SKILL_CMD+'\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【本次任务】复盘。请针对下面这条最新证据做对照复盘，不要重复之前的回答：'
    +'\n最新动作：'+latest.action+'\n实际投入：'+(latest.input||'未填')+'\n结果：'+(latest.result||'未填')
    +'\n证据：'+(latest.evidence||'未填')+(latest.note?'\n用户备注：'+latest.note:'')
    +'\n逐条对照事前标准与停止条件，给出 review 协议块（next 与 suggest 必填）。';
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

    if(P==='/api/health')return send(res,200,{ok:true,version:VERSION,service:'chengshi-workshop'});
    if(!P.startsWith('/api/'))return serveStatic(res,P);
    if(req.headers['x-chengshi-token']!==token)return send(res,401,{error:'unauthorized'});
    const parts=P.split('/').filter(Boolean);
    const body=['POST','PUT'].includes(req.method)?await readBody(req):{};

    if(P==='/api/methods'){
      const out=[];
      for(const dir of ['chapters','deep-dive']){
        const d=path.join(ROOT,dir);
        if(fs.existsSync(d))for(const f of fs.readdirSync(d).filter(f=>f.endsWith('.md')).sort())
          out.push({path:dir+'/'+f,title:f.replace(/\.md$/,'')});
      }
      return send(res,200,{methods:out});
    }
    if(P==='/api/methods/content'){
      const rel=(u.searchParams.get('p')||'').replace(/\\/g,'/');
      const full=path.resolve(ROOT,rel);
      const rel2=path.relative(ROOT,full);
      if(rel2.startsWith('..')||path.isAbsolute(rel2)||!full.endsWith('.md')||!fs.existsSync(full))
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

      /* 讨论/回答: 入口查base,AI返回后基于最新状态合并,绝不回写旧快照 */
      if(parts[3]==='messages'&&req.method==='POST'){
        if(!body.text||!body.text.trim())return send(res,400,{error:'text-required'});
        const entry=loadProject(id);
        if(!entry)return send(res,404,{error:'not-found'});
        if(!needBase(entry))return;
        const entryVersion=entry.version;
        const userMsg={role:'user',text:body.text.trim(),at:new Date().toISOString()};
        const r=await callClaude({prompt:discussPrompt(entry,body.text.trim()),sessionId:entry.sessionId,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){
          /* 失败: 不落任何写,并发期间的其他修改原样保留 */
          const cur=loadProject(id);
          return send(res,502,{error:'ai-call-failed',detail:r.error,project:cur});
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
            /* 草案不触碰已确认计划; 覆盖旧草案须无妨,但保留痕迹 */
            if(F.planDraft)F.planHistory.push({...F.planDraft,archivedAt:new Date().toISOString(),archiveReason:'被新草案替换'});
            F.planDraft={...proto.data,version:F.plan?F.plan.version+1:1,author:'ai',createdAt:new Date().toISOString()};
          }
          if(F.version!==entryVersion)aiMsg.stale=true;          /* AI期间有人改过数据,复盘基于稍早状态 */
          saveProject(F);
          return F;
        });
        return send(res,200,{project:merged,ai:{callOk:true,protocolOk:proto.ok,protocol:proto.ok?{type:proto.type,...proto.data}:null,error:proto.ok?undefined:proto.error}});
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
          if(F.planDraft)F.planHistory.push({...F.planDraft,archivedAt:new Date().toISOString(),archiveReason:body.reason||'草案被修改'});
          F.planDraft={question:body.question.trim(),action:body.action.trim(),accept:body.accept.trim(),
            budget:body.budget.trim(),stop:body.stop.trim(),evidenceToBring:body.evidenceToBring.trim(),
            reason:(body.reason||'').trim(),version:F.plan?F.plan.version+1:1,
            author:body.author==='user'?'user':'ai',createdAt:new Date().toISOString()};
          return saveProject(F);
        });
        if(!result)return;                                       /* needBase/校验已回包 */
        return send(res,200,{project:result});
      }

      /* 执行记录(证据),关联当前已确认计划版本 */
      if(parts[3]==='executions'&&req.method==='POST'){
        const result=await withLock(id,()=>{
          const F=loadProject(id);
          if(!F){send(res,404,{error:'not-found'});return null;}
          if(!needBase(F))return null;
          if(!body.action||!body.action.trim())return send(res,400,{error:'action-required'}),null;
          const e={id:'e'+Date.now().toString(36)+crypto.randomBytes(2).toString('hex'),
            action:body.action.trim(),input:(body.input||'').trim(),result:(body.result||'').trim(),
            evidence:(body.evidence||'').trim(),note:(body.note||'').trim(),
            planVersion:F.plan&&F.plan.status==='confirmed'?F.plan.version:0,
            at:new Date().toISOString()};
          if(!validExecution(e))return send(res,400,{error:'bad-execution'}),null;
          F.executions.push(e);
          return saveProject(F);
        });
        if(!result)return;
        return send(res,200,{project:result,execution:result.executions[result.executions.length-1]});
      }

      /* 带着最新证据续谈复盘: 只接受合法 review 协议才计入"已复盘" */
      if(parts[3]==='review'&&req.method==='POST'){
        const entry=loadProject(id);
        if(!entry)return send(res,404,{error:'not-found'});
        if(!needBase(entry))return;
        const entryVersion=entry.version;
        const hasReal=entry.executions.some(e=>(e.result&&e.result.trim())||(e.evidence&&e.evidence.trim()));
        if(!hasReal)return send(res,400,{error:'no-real-evidence'});
        if(!entry.sessionId)return send(res,400,{error:'no-session'});
        const r=await callClaude({prompt:reviewPrompt(entry),sessionId:entry.sessionId,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){
          const cur=loadProject(id);
          return send(res,502,{error:'ai-call-failed',detail:r.error,project:cur});
        }
        const proto=parseProtocol(r.text);
        const isReview=proto.ok&&proto.type==='review';
        const merged=await withLock(id,()=>{
          const F=loadProject(id);
          F.discussion.push({role:'ai',text:r.text,at:new Date().toISOString(),cost:r.costUsd,kind:'review',
            protocol:isReview?{type:'review',...proto.data}:null,
            protoError:isReview?undefined:(proto.ok?('unexpected-type:'+proto.type):proto.error),
            stale:F.version!==entryVersion});
          if(isReview)F.stage='review';
          return saveProject(F);
        });
        return send(res,200,{project:merged,ai:{callOk:true,protocolOk:isReview,
          protocol:isReview?{type:'review',...proto.data}:null,
          error:isReview?undefined:(proto.ok?('unexpected-type:'+proto.type):proto.error)}});
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

/* ---- 启动 ---- */
function start(){
  const tryListen=(pt,left)=>{
    server.once('error',err=>{
      if(err.code==='EADDRINUSE'&&left>0)return tryListen(pt+1,left-1);
      console.error('[成事工坊] 端口占用,启动失败:',err.message);process.exit(1);
    });
    server.listen(pt,'127.0.0.1',()=>{
      port=pt;
      fs.writeFileSync(rtFile,JSON.stringify({token,port,pid:process.pid,version:VERSION},null,2));
      console.log('[成事工坊] 本地服务已启动:');
      console.log('  工作台  http://127.0.0.1:'+pt+'/');
      console.log('  数据目录 '+DATA);
      console.log('  停止    Ctrl+C');
    });
  };
  tryListen(port||4310,20);
}
start();
