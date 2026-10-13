/* 成事工坊 · 本地项目服务
 * 纯 Node 零依赖。职责: 伺服工作台页面 / 统一保存项目数据 / 调用 Claude Code 适配器。
 * 只监听 127.0.0.1; token 鉴权; 版本+冲突检查; 原子写入,失败保留旧记录。
 * 健康检查不发起模型调用。
 */
const http=require('http');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const {callClaude}=require('./adapter');
const {parseProtocol,validExecution,validDecision}=require('./schemas');

const ROOT=path.resolve(__dirname,'..');            /* 随包资源根(插件根) */
const APP=path.join(ROOT,'app');
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const PROJ=path.join(DATA,'projects');
fs.mkdirSync(PROJ,{recursive:true});

const VERSION='0.1.0-stage1';

/* ---- 运行时状态(端口/token 重启复用) ---- */
let token,port;
const rtFile=path.join(DATA,'runtime.json');
try{
  const rt=JSON.parse(fs.readFileSync(rtFile,'utf8'));
  token=rt.token;port=rt.port;
}catch(_){ token=crypto.randomBytes(16).toString('hex');port=0; }

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
    discussion:[],plan:null,planHistory:[],executions:[],decision:null,sessionId:null};
}

/* ---- 提示词构建: 上下文 + 数据协议 + 明确任务 ---- */
function contextBlock(p){
  const L=[];
  L.push('【当前事项】\n念头：'+p.idea);
  if(p.plan){
    const pl=p.plan;
    L.push('【'+(pl.status==='confirmed'?'已确认计划(v'+pl.version+')':'待确认计划草案(v'+pl.version+')')+'】'
      +'\n要验证：'+pl.question+'\n动作：'+pl.action+'\n完成标准：'+pl.accept
      +'\n投入上限：'+pl.budget+'\n停止条件：'+pl.stop+'\n要带回的证据：'+pl.evidenceToBring
      +(pl.reason?'\n说明：'+pl.reason:''));
  }
  if(p.executions.length){
    L.push('【执行记录 · 按时间顺序,最后一条最新】\n'+p.executions.map((e,i)=>
      `${i+1}. 动作:${e.action}｜实际投入:${e.input||'未填'}｜结果:${e.result||'未填'}\n   证据:${e.evidence||'未填'}${e.note?'｜备注:'+e.note:''}（${e.at.slice(0,10)}）`).join('\n'));
  }
  if(p.decision)L.push('【当前结局决定】'+({done:'达成',go:'继续验证',pause:'暂停',stop:'终止'})[p.decision.type]+'：'+p.decision.reason);
  return L.join('\n\n');
}
const CONTRACT=`【运行环境】你在「成事工坊」本地工作台里被调用，讨论只围绕上面这一件事。不要使用或读取任何个人记忆文件；需要方法细节时，只读安装目录下的 chapters/、deep-dive/、tools/（已授权）。
【纪律】区分事实与假设，不把假设记成事实；不凭聊天判断市场已可行；计划草案必须等用户在网页上确认后才生效；你不替用户确认计划或结局。
【数据协议】每一轮都是独立回复：不要复述之前轮次说过的内容，只回应当前任务与最新信息。正文写给用户看，语气直接、少客套。正文之后必须另起一行输出且只输出一个 fenced code block（以三个反引号加 json 开头、以三个反引号结尾，块不完整视为接口故障），内容只含以下三种之一，不要输出任何其他 JSON 块：
{"type":"questions","items":["当前最影响判断的问题"]}            —— 信息不足以出计划时
{"type":"plan","question":"本计划要验证什么","action":"具体动作(能今天就开干的)","accept":"做到什么程度算完","budget":"投入上限(时间/钱,写数字)","stop":"出现什么结果该停","evidenceToBring":"要带回的证据"}  —— 信息足够时
{"type":"review","result":"实际结果对照事前标准","assumptionDelta":"原假设获得或失去的支持","stillUnknown":"仍未知的部分","next":"建议的下一步","suggest":"continue|adjust|pause|stop"}  —— 复盘时`;

function discussPrompt(p,userText){
  return '/idea-to-done\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【用户刚说的话】\n'+userText
    +'\n\n【本次任务】'+(p.stage==='execute'
      ?'用户已在执行或刚补充了情况。若信息足够给出下一轮计划草案，否则先问最关键的补充问题。'
      :'这是本事项的开场讨论。先澄清事实、假设、未知项与投入边界；信息不足以出计划时，问当前最影响判断的问题（不超过3个）；足够时直接给计划草案。');
}
function reviewPrompt(p){
  const latest=p.executions[p.executions.length-1];
  return '/idea-to-done\n\n'+CONTRACT+'\n\n'+contextBlock(p)
    +'\n\n【本次任务】复盘。请针对下面这条最新证据做对照复盘，不要重复之前的回答：'
    +'\n最新动作：'+latest.action+'\n实际投入：'+(latest.input||'未填')+'\n结果：'+(latest.result||'未填')
    +'\n证据：'+(latest.evidence||'未填')+(latest.note?'\n用户备注：'+latest.note:'')
    +'\n逐条对照事前标准与停止条件，给出 review 协议块。';
}

/* ---- HTTP 层 ---- */
function send(res,code,obj,extra){
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',...(extra||{})});
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
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8'};

function serveStatic(res,urlPath){
  if(urlPath==='/'||urlPath==='/index.html'){
    let html=fs.readFileSync(path.join(APP,'index.html'),'utf8');
    html=html.split('__TOKEN__').join(token).split('__PORT__').join(String(port));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(html);
  }
  const rel=decodeURIComponent(urlPath.replace(/^\//,''));
  const full=path.resolve(ROOT,rel);
  if(!full.startsWith(ROOT)||!fs.existsSync(full)||!fs.statSync(full).isFile())
    return send(res,404,{error:'not-found'});
  res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'application/octet-stream'});
  fs.createReadStream(full).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  const P=u.pathname;
  try{
    /* 健康检查: 无鉴权、无模型调用 */
    if(P==='/api/health')return send(res,200,{ok:true,version:VERSION,auth:!!req.headers['x-chengshi-token']||undefined});
    /* 静态页与登录页 */
    if(!P.startsWith('/api/'))return serveStatic(res,P);
    /* API 鉴权 */
    if(req.headers['x-chengshi-token']!==token)return send(res,401,{error:'unauthorized'});
    const parts=P.split('/').filter(Boolean); /* api projects ... */
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
      if(rel.includes('..'))return send(res,400,{error:'bad-path'});
      const full=path.resolve(ROOT,rel);
      if(!full.startsWith(ROOT)||!full.endsWith('.md')||!fs.existsSync(full))
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
      const p=loadProject(parts[2]);
      if(!p)return send(res,404,{error:'not-found'});
      const needBase=()=>{if(body.base!==undefined&&body.base!==p.version)return send(res,409,{error:'conflict',current:p.version}),false;return true;};

      if(parts.length===3&&req.method==='GET')return send(res,200,{project:p});

      /* 讨论/回答(真实调用 Skill) */
      if(parts[3]==='messages'&&req.method==='POST'){
        if(!needBase())return;
        if(!body.text||!body.text.trim())return send(res,400,{error:'text-required'});
        p.discussion.push({role:'user',text:body.text.trim(),at:new Date().toISOString()});
        const r=await callClaude({prompt:discussPrompt(p,body.text.trim()),sessionId:p.sessionId,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){
          p.discussion.pop();                       /* 调用失败: 保留输入,不写假记录 */
          saveProject(p);
          return send(res,502,{error:'ai-call-failed',detail:r.error,project:p});
        }
        const proto=parseProtocol(r.text);
        p.sessionId=r.sessionId||p.sessionId;
        p.discussion.push({role:'ai',text:r.text,protocol:proto.ok?{type:proto.type,...proto.data}:null,at:new Date().toISOString(),cost:r.costUsd});
        if(proto.ok&&proto.type==='plan'){
          p.planHistory.push(p.plan?{...p.plan,archivedAt:new Date().toISOString()}:null);
          p.plan={...proto.data,version:(p.plan?p.plan.version:0)+1,author:'ai',status:'draft',createdAt:new Date().toISOString()};
        }
        saveProject(p);
        return send(res,200,{project:p,ai:{ok:true,protocol:proto.ok?proto.data:null,error:proto.ok?undefined:proto.error}});
      }

      /* 确认计划(须在保存计划之前匹配) */
      if(parts[3]==='plan'&&parts[4]==='confirm'&&req.method==='POST'){
        if(!needBase())return;
        if(!p.plan)return send(res,400,{error:'no-plan'});
        p.plan.status='confirmed';p.plan.confirmedAt=new Date().toISOString();
        p.stage='execute';
        saveProject(p);
        return send(res,200,{project:p});
      }
      /* 保存/修改计划(用户确认前为草案; 覆盖已确认计划须给原因并留档) */
      if(parts[3]==='plan'&&req.method==='POST'){
        if(!needBase())return;
        const need=['question','action','accept','budget','stop','evidenceToBring'];
        if(need.some(k=>!body[k]||!body[k].trim()))return send(res,400,{error:'plan-fields-required'});
        if(p.plan&&p.plan.status==='confirmed'&&!(body.reason&&body.reason.trim()))
          return send(res,400,{error:'reason-required-to-change-confirmed-plan'});
        if(p.plan)p.planHistory.push({...p.plan,archivedAt:new Date().toISOString(),archiveReason:body.reason||''});
        p.plan={question:body.question.trim(),action:body.action.trim(),accept:body.accept.trim(),
          budget:body.budget.trim(),stop:body.stop.trim(),evidenceToBring:body.evidenceToBring.trim(),
          reason:(body.reason||'').trim(),version:p.plan?p.plan.version+1:1,
          author:body.author==='user'?'user':'ai',status:'draft',createdAt:new Date().toISOString()};
        saveProject(p);
        return send(res,200,{project:p});
      }

      /* 执行记录(证据) */
      if(parts[3]==='executions'&&req.method==='POST'){
        if(!needBase())return;
        if(!body.action||!body.action.trim())return send(res,400,{error:'action-required'});
        const e={id:'e'+Date.now().toString(36)+crypto.randomBytes(2).toString('hex'),
          action:body.action.trim(),input:(body.input||'').trim(),result:(body.result||'').trim(),
          evidence:(body.evidence||'').trim(),note:(body.note||'').trim(),at:new Date().toISOString()};
        if(!validExecution(e))return send(res,400,{error:'bad-execution'});
        p.executions.push(e);
        saveProject(p);
        return send(res,200,{project:p,execution:e});
      }

      /* 带着最新证据续谈复盘(真实调用,传独立会话) */
      if(parts[3]==='review'&&req.method==='POST'){
        if(!needBase())return;
        if(!p.executions.length)return send(res,400,{error:'no-evidence'});
        if(!p.sessionId)return send(res,400,{error:'no-session'});
        const r=await callClaude({prompt:reviewPrompt(p),sessionId:p.sessionId,cwd:ROOT,methodsRoot:ROOT});
        if(!r.ok){saveProject(p);return send(res,502,{error:'ai-call-failed',detail:r.error,project:p});}
        const proto=parseProtocol(r.text);
        p.discussion.push({role:'ai',text:r.text,protocol:proto.ok?{type:proto.type,...proto.data}:null,
          at:new Date().toISOString(),cost:r.costUsd,kind:'review'});
        p.stage='review';
        saveProject(p);
        return send(res,200,{project:p,ai:{ok:true,protocol:proto.ok?proto.data:null,error:proto.ok?undefined:proto.error}});
      }

      /* 结局决定(用户确认动作, 任何时候可记) */
      if(parts[3]==='decision'&&req.method==='POST'){
        if(!needBase())return;
        if(!['done','go','pause','stop'].includes(body.type))return send(res,400,{error:'bad-decision-type'});
        const d={type:body.type,reason:(body.reason||'').trim(),at:new Date().toISOString(),version:p.version};
        if(!validDecision(d))return send(res,400,{error:'bad-decision'});
        p.decision=d;p.status=body.type==='go'?'active':body.type;
        saveProject(p);
        return send(res,200,{project:p});
      }
    }
    send(res,404,{error:'not-found'});
  }catch(e){
    send(res,500,{error:'server-error',detail:String(e.message||e).slice(0,200)});
  }
});

/* ---- 启动: 端口冲突自动顺延, 写运行时文件 ---- */
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
