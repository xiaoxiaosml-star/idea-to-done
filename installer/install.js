/* 成事工坊 · 一键安装器 (Windows 首发)
 * 职责: 检测前提(node+已登录的Claude Code)→ 注册并安装插件 → 准备数据目录
 *       → 生成启动器与快捷方式 → 启动服务并健康检查(健康检查不发起模型调用)。
 * 重复执行=更新: 不动用户数据,只刷新插件与组件。任何一步失败即中止并报真实原因。
 */
const {spawnSync,execFileSync,spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');

const ROOT=path.resolve(__dirname,'..');
const APP_NAME='成事工坊';
const PLUGIN='chengshi-workshop';
const MARKET='chengshi-workshop-local';
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const LOG=path.join(DATA,'install.log');
const MIN_CLAUDE='2.0.0';
/* 版本唯一真源 runtime/version.json(server/launcher 同读) */
const EXPECTED=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,'runtime','version.json'),'utf8')).version;}catch(_){return '0.1.5-stage4';}})();

let logReady=false;
const log=(...a)=>{const s=a.join(' ');console.log(s);
  try{fs.mkdirSync(DATA,{recursive:true});fs.appendFileSync(LOG,'['+new Date().toISOString()+'] '+s+'\n');logReady=true;}
  catch(e){
    console.log('✘ 数据目录不可用: '+DATA+' — '+(e.code||'')+' '+(e.message||e));
    console.log('安装中止。请检查该路径(是否被文件占用/权限不足),或用 CHENGSHI_DATA 指定可写目录后重试。');
    process.exit(1);
  }};
const fail=(msg)=>{log('✘ '+msg);log('安装中止。已完成的步骤保留,修好上面这个问题后重新运行本安装器即可。');process.exit(1);};
/* Node 解析: 优先随包便携运行时,其次系统 PATH */
function resolveNode(){
  const local=path.join(__dirname,'runtime','node','node.exe');
  if(fs.existsSync(local))return local;
  return 'node';
}
function run(cmd,args,opts={}){
  const r=spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,...opts});
  return {code:r.status,out:(r.stdout||'')+(r.stderr||''),err:r.error};
}
function sh(quoted){
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',quoted],{encoding:'utf8',windowsHide:true});
  return {code:r.status,out:(r.stdout||'')+(r.stderr||'')};
}

/* ---- 0. 前提检测 ---- */
log('═══ 成事工坊 安装开始 ═══');
const nodeV=process.version;
log('① Node 运行时: '+nodeV);

(async()=>{

let claudeExe=null;
const claudeCand=[
  process.env.CLAUDE_CODE_EXE,
  path.join(os.homedir(),'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
  'claude'
].filter(Boolean);
for(const c of claudeCand){
  const t=c==='claude'?'claude':c;
  const r=run(t,['--version']);
  if(r.code===0){claudeExe=t;break;}
}
if(!claudeExe)fail('未找到 Claude Code。请先安装并登录 Claude Code,再运行本安装器。(找过: '+claudeCand.join(', ')+')');
const verOut=run(claudeExe,['--version']).out.trim();
log('② Claude Code: '+verOut);
const mv=(verOut.match(/(\d+\.\d+\.\d+)/)||[])[1];
if(mv){const a=mv.split('.').map(Number),b=MIN_CLAUDE.split('.').map(Number);
  const cmp=a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
  if(cmp<0)log('  ⚠ 已验证的最低版本为 '+MIN_CLAUDE+',当前 '+mv+' 低于它,可能不兼容,继续但请留意');}

/* 登录验证: 一次最小调用,失败即中止(不代创账号,不绕过凭据) */
log('③ 登录验证(向 Claude 发一次最小调用确认已登录,费用由你的账户承担)…');
const authProbe=run(claudeExe,['-p','只回复两个字:在的','--max-turns','1','--output-format','json'],{cwd:ROOT});
const probeLine=[...(authProbe.out||'').split(/\r?\n/)].reverse().find(l=>l.trim().startsWith('{'));
let probeOk=false;
if(probeLine){try{
  const pd=JSON.parse(probeLine);
  /* API 有真实往返(产生token消耗)即视为已登录; max_turns截断等属调用行为问题,不是登录问题 */
  probeOk=(pd.subtype==='success')||((pd.usage||{}).input_tokens>0&&pd.session_id);
}catch(_){}}
if(!probeOk){
  const snippet=(authProbe.out||'').slice(0,400);
  fail('Claude Code 登录验证失败。请先在终端运行 claude 登录,再重试。输出: '+snippet);
}
log('  登录可用 ✔');

/* ---- 1. 插件注册与安装 ---- */
log('④ 注册插件分发目录…');
const normPath=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase().replace(/\/+$/,'');
let mList=run(claudeExe,['plugin','marketplace','list']).out;
let needAdd=!mList.includes(MARKET);
if(!needAdd){
  /* 同名分发目录已存在: 必须指向当前这套安装包, 不能沿用别处(如开发仓库)的旧注册 */
  const seg=(mList.split(MARKET)[1]||'').split('❯')[0];
  const pm=seg.match(/Source:\s*Directory\s*\(([^)]+)\)/i);
  if(pm&&normPath(pm[1])!==normPath(ROOT)){
    log('  检测到同名分发目录指向另一处: '+pm[1]);
    const rr=run(claudeExe,['plugin','marketplace','remove',MARKET]);
    if(rr.code!==0)fail('移除旧分发目录失败: '+rr.out.slice(0,300));
    log('  已移除旧指向,重新注册到当前安装包');
    needAdd=true;
  }
}
if(!needAdd)log('  分发目录已存在且指向本安装包,跳过注册');
else{
  const r=run(claudeExe,['plugin','marketplace','add',ROOT]);
  if(r.code!==0||!r.out.includes('uccess'))fail('注册分发目录失败: '+r.out.slice(0,300));
  log('  已注册 '+MARKET);
}
log('⑤ 安装/更新插件…');
let pList=run(claudeExe,['plugin','list']).out;
if(pList.includes(PLUGIN)&&!pList.split(PLUGIN)[1].slice(0,200).includes('disabled')){
  log('  插件已安装且启用,执行更新…');
  const ru=run(claudeExe,['plugin','marketplace','update',MARKET]);
  if(ru.code!==0)fail('插件分发目录更新失败: '+ru.out.slice(0,300));
  const ri=run(claudeExe,['plugin','install',PLUGIN+'@'+MARKET]);
  if(ri.code!==0)fail('插件更新安装失败: '+ri.out.slice(0,300));
}else{
  const r=run(claudeExe,['plugin','install',PLUGIN+'@'+MARKET]);
  if(r.code!==0&&!r.out.includes('uccess'))fail('安装插件失败: '+r.out.slice(0,300));
  run(claudeExe,['plugin','enable',PLUGIN+'@'+MARKET]);
}
/* 终态核对: 必须真的装上且启用,组件在 */
pList=run(claudeExe,['plugin','list']).out;
const seg=pList.split(PLUGIN)[1]||'';
if(!pList.includes(PLUGIN)||seg.slice(0,300).includes('disabled'))
  fail('插件终态核对失败: 未检测到已启用的 '+PLUGIN);
const det=run(claudeExe,['plugin','details',PLUGIN+'@'+MARKET]).out;
if(!det.includes('idea-to-done'))fail('插件终态核对失败: 组件清单里没有 idea-to-done skill');
log('  插件就绪 ✔(已核对启用状态与组件清单)');

/* ---- 2. 数据目录与安装清单 ---- */
log('⑥ 准备数据目录(与插件缓存分离,更新不清空)…');
fs.mkdirSync(path.join(DATA,'projects'),{recursive:true});
fs.writeFileSync(path.join(DATA,'install.json'),JSON.stringify({
  installedAt:new Date().toISOString(),version:EXPECTED,
  root:ROOT,minClaude:MIN_CLAUDE,claudeFound:verOut
},null,2));

/* ---- 3. 启动器 + 快捷方式 ---- */
log('⑦ 生成启动器与快捷方式…');
const launcher=path.join(ROOT,'成事工坊.cmd');
fs.writeFileSync(launcher,
'@echo off\r\nchcp 65001 >nul\r\nset "ROOT=%~dp0"\r\n' +
'set "NODE=node"\r\nif exist "%ROOT%installer\\runtime\\node\\node.exe" set "NODE=%ROOT%installer\\runtime\\node\\node.exe"\r\n' +
'"%NODE%" "%ROOT%runtime\\launcher.js" %*\r\nif errorlevel 1 pause\r\n'
,'utf8');
const lnkPs=[
  '$ws=New-Object -ComObject WScript.Shell;',
  '$s=$ws.CreateShortcut("'+path.join(os.homedir(),'Desktop',APP_NAME+'.lnk').replace(/\\/g,'\\\\')+'");',
  '$s.TargetPath="'+launcher.replace(/\\/g,'\\\\')+'";',
  '$s.WorkingDirectory="'+ROOT.replace(/\\/g,'\\\\')+'";',
  '$s.IconLocation="shell32.dll,43";',
  '$s.Save()'
].join('');
const lnk=sh(lnkPs);
if(lnk.code!==0)log('  ⚠ 桌面快捷方式创建失败(不影响使用,可直接运行 成事工坊.cmd): '+lnk.out.slice(0,200));
else log('  桌面快捷方式已创建 ✔');
/* 开机自启: 默认关闭; --startup 开启; --no-startup 关闭; 交互终端询问(默认N) */
const startup=path.join(os.homedir(),'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',APP_NAME+'.lnk');
const mkStartup=()=>{
  const sp=[
    '$ws=New-Object -ComObject WScript.Shell;',
    '$s=$ws.CreateShortcut("'+startup.replace(/\\/g,'\\\\')+'");',
    '$s.TargetPath="'+launcher.replace(/\\/g,'\\\\')+'";',
    '$s.Arguments="--tray";',
    '$s.WorkingDirectory="'+ROOT.replace(/\\/g,'\\\\')+'";',
    '$s.Save()'
  ].join('');
  const r=sh(sp);
  if(r.code===0&&fs.existsSync(startup))log('  已加入开机自启(只拉起本地服务,不弹窗) ✔');
  else log('  ⚠ 开机自启创建失败: '+r.out.slice(0,200));
};
const rmStartup=()=>{try{fs.unlinkSync(startup);log('  已移除开机自启 ✔');}catch(_){}};
const arg=process.argv.slice(2);
if(arg.includes('--startup'))mkStartup();
else if(arg.includes('--no-startup'))rmStartup();
else if(process.stdin.isTTY){
  const ans=(await new Promise(res=>{
    process.stdout.write('  是否加入开机自启(只静默拉起本地服务,不弹窗)? [y/N] ');
    process.stdin.once('data',d=>res(d.toString().trim().toLowerCase()));
  })).startsWith('y');
  if(ans)mkStartup();else rmStartup();
}else{ log('  非交互环境: 保持开机自启现状(默认不新增)'); }

/* ---- 4. 启动服务 + 健康检查(无模型调用) ----
 * 五元严格核对: 服务身份 + 数据目录指纹(data) + 实例指纹(iid) + 版本 + 安装来源指纹(root)。
 * 缺指纹旧服务不放行; 同目录旧版本/旧来源进程只在三重链式核实(rt记录来源根→健康回包
 * 来源指纹→pid命令行脚本绝对路径)之后才终止; 终止失败或旧进程不退出即如实中止,
 * 一次运行至多启动一次服务, 绝不双开同数据目录。 */
log('⑧ 启动本地服务并健康检查…');
const crypto=require('crypto');
const norm=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase();   /* 归一化口径与 server.js 一致 */
const FP=crypto.createHash('sha1').update(DATA).digest('hex').slice(0,12);
const ROOT_FP=crypto.createHash('sha1').update(norm(ROOT)).digest('hex').slice(0,12);
const FPof=p=>crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0,12);
const readRt=()=>{try{return JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));}catch(_){return null;}};
/* 进程归属核实(三重比对, 防 pid 复用误杀别的项目的同名 runtime/server.js):
   1) CIM 调用本身成功; 2) 只从 stdout 解析脚本绝对路径(stderr 里的文本不放行);
   3) 归一化后与"期望安装根"下的 runtime/server.js 精确相等。 */
const ownsServer=(pid,expectedRoot)=>{
  if(!pid||!expectedRoot)return false;
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  if(r.error||r.status!==0||!r.stdout)return false;
  const m=r.stdout.match(/"?([A-Za-z]:[^"\r\n]*?[\\/]runtime[\\/]server\.js)"?/);
  if(!m)return false;
  return norm(m[1])===norm(path.join(expectedRoot,'runtime','server.js'));
};
/* 终止并确认退出: kill 被拒或旧进程超时未退都返回错误串, 调用方不得再启动新服务 */
const pause=ms=>{const e=Date.now()+ms;while(Date.now()<e);};
const killAndConfirm=(pid)=>{
  try{process.kill(pid);}
  catch(e){return '终止请求被拒('+(e.code||e.message)+')';}
  for(let i=0;i<20;i++){
    const t=spawnSync('tasklist',['/FI','PID eq '+pid,'/NH'],{encoding:'utf8',windowsHide:true});
    if(t.error||t.status!==0)return '无法确认旧进程是否退出(tasklist 调用失败)';
    if(!((t.stdout||'')+(t.stderr||'')).includes(String(pid)))return null;   /* 已退出 */
    pause(400);
  }
  return '旧进程未在时限内退出';
};
/* full(五元全对)|srclash(同DATA同版本但来源目录不符)|stale(我目录的旧服务)
 * |other(别的数据目录)|old(缺任一指纹的旧服务)|null(非本服务) */
const classify=(port)=>new Promise(res=>{
  const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1500},r=>{
    let b='';r.on('data',d=>b+=d);r.on('end',()=>{
      let j=null;try{j=JSON.parse(b);}catch(_){}
      if(!j||j.ok!==true||j.service!=='chengshi-workshop')return res({c:null});
      if(!j.data||!j.iid||!j.root)return res({c:'old',j});     /* 缺任一指纹都不放行 */
      const rt=readRt();
      if(j.data!==FP)return res({c:'other',j});
      if(rt&&j.iid!==rt.iid)return res({c:'stale',j});
      if(EXPECTED&&j.version!==EXPECTED)return res({c:'stale',j});
      if(j.root!==ROOT_FP)return res({c:'srclash',j});          /* 同DATA但来自别的安装目录 */
      res({c:'full',j});
    });
  });
  req.on('timeout',()=>{req.destroy();res({c:null});});
  req.on('error',()=>res({c:null}));
});
async function findService(){
  const rt=readRt();
  const first=rt&&rt.port?rt.port:4310;
  const rank={old:3,stale:3,srclash:3,other:1};               /* 可疑信号优先于 other, 不被覆盖 */
  let r=await classify(first);
  if(r.c==='full')return{port:first,seen:r.c,body:r.j};
  let seen=r.c,body=r.j;
  for(let p=4310;p<=4330;p++){
    if(p===first)continue;
    r=await classify(p);
    if(r.c==='full')return{port:p,seen:r.c,body:r.j};
    if(r.c&&(!seen||((rank[r.c]||0)>(rank[seen]||0)))){seen=r.c;body=r.j;}
  }
  return{port:null,seen,body};
}
const spawnOnce=()=>{
  const child=spawn(resolveNode(),[path.join(ROOT,'runtime','server.js')],{cwd:ROOT,env:process.env,windowsHide:true,stdio:'ignore',detached:true});
  child.unref();
};
let found=await findService();
let spawned=false;
if(!found.port){
  const rt=readRt();
  /* 可终止重启(三重链式核实, 缺一不可) */
  const okKill=(found.seen==='stale'||found.seen==='srclash')&&rt&&rt.root
    &&found.body&&found.body.root===FPof(rt.root)&&ownsServer(rt.pid,rt.root);
  if(okKill){
    log('  检测到本数据目录的旧版服务(归属与安装来源已核实),终止并拉起当前版本…');
    const kerr=killAndConfirm(rt.pid);
    if(kerr)fail('旧服务终止未成功('+kerr+'),未启动新服务(避免两个服务同写数据目录)。数据不会丢失,请手动处理后再重试。');
    spawnOnce();spawned=true;                                  /* 旧进程已确认退出才拉新版 */
    for(let i=0;i<25&&!found.port;i++){await new Promise(r=>setTimeout(r,800));found=await findService();}
    if(!found.port)fail('旧服务已终止,但新服务健康检查未通过。未再次启动;请运行 成事工坊.cmd 或手动执行 node runtime/server.js 排查。');
  }else if(found.seen==='old'||found.seen==='stale'||found.seen==='srclash'){
    /* 归属核实不过: 它可能正占着本数据目录, 盲启第二个服务会双写数据 → 如实中止 */
    fail('检测到'+({old:'旧版服务(缺少指纹)',stale:'本数据目录的旧进程',
      srclash:'其他安装目录的同版本服务',other:'其他数据目录的实例'}[found.seen])
      +',但无法可靠核实进程归属与安装来源,未终止任何进程、也未启动新服务(避免两个服务同写数据目录)。'
      +'请手动结束残留 node 进程后重试;数据不会丢失。');
  }
}
if(!found.port&&!spawned){                                    /* 只剩"没服务/只有别人DATA的实例"才全新启动 */
  spawnOnce();spawned=true;
  for(let i=0;i<20&&!found.port;i++){await new Promise(r=>setTimeout(r,800));found=await findService();}
}
if(!found.port){
  const what={old:'旧版服务(缺少指纹,无法确认归属)',stale:'本数据目录的旧进程(归属核实未通过)',
    srclash:'其他安装目录的同版本服务(来源核实未通过)',other:'其他数据目录的实例(不影响,但本实例未能启动)'}[found.seen]||'未知原因';
  fail('服务未能确认。'+what+'。本次运行已启动过一次但健康检查未通过,未再次启动。未强行终止任何进程;数据不会丢失。');
}
const finalRt=readRt();
log('  服务健康 ✔ http://127.0.0.1:'+found.port+'/ ｜ v'+EXPECTED+' ｜ 实例 '+String(finalRt&&finalRt.iid||'?')+' ｜ 数据目录指纹 '+FP);
const h={port:found.port};

log('═══ 安装完成 ═══');
log('日常用法: 双击桌面「成事工坊」→ 开始或继续一件事。');
log('数据目录: '+DATA+'(更新插件不会清空它)');
log('安装日志: '+LOG);
/* 安装完成直接打开工作台(可用 CHENGSHI_NO_OPEN=1 跳过) */
if(!process.env.CHENGSHI_NO_OPEN)
  spawnSync('cmd.exe',['/c','start','','http://127.0.0.1:'+h.port+'/'],{windowsHide:true});
process.exit(0);
})().catch(e=>{fail('未捕获异常: '+(e&&e.message||e));});
