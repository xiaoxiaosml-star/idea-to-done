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
 * 四元严格核对: 服务身份 + 数据目录指纹(data) + 实例指纹(iid) + 版本。
 * 缺指纹旧服务不放行; 同目录旧版本进程只在命令行核实归属后才终止重启。 */
log('⑧ 启动本地服务并健康检查…');
const FP=require('crypto').createHash('sha1').update(DATA).digest('hex').slice(0,12);
const readRt=()=>{try{return JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));}catch(_){return null;}};
const ownsServer=(pid)=>{
  if(!pid)return false;
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  return /runtime[\\\/]server\.js/.test((r.stdout||'')+(r.stderr||''));
};
const classify=(port)=>new Promise(res=>{
  const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1500},r=>{
    let b='';r.on('data',d=>b+=d);r.on('end',()=>{
      let j=null;try{j=JSON.parse(b);}catch(_){}
      if(!j||j.ok!==true||j.service!=='chengshi-workshop')return res(null);
      if(!j.data||!j.iid)return res('old');
      const rt=readRt();
      if(j.data!==FP)return res('other');
      if(rt&&j.iid!==rt.iid)return res('stale');
      if(EXPECTED&&j.version!==EXPECTED)return res('stale');
      res('full');
    });
  });
  req.on('timeout',()=>{req.destroy();res(null);});
  req.on('error',()=>res(null));
});
async function findService(){
  const rt=readRt();
  const first=rt&&rt.port?rt.port:4310;
  let c=await classify(first);
  if(c==='full')return{port:first};
  let seen=c;                                               /* 可疑(old/stale)优先于 other, 不被覆盖 */
  for(let p=4310;p<=4330;p++){
    if(p===first)continue;
    c=await classify(p);
    if(c==='full')return{port:p};
    if(c&&(seen===null||seen==='other'))seen=c;
  }
  return{port:null,seen};
}
let found=await findService();
if(!found.port){
  const rt=readRt();
  const killable=(found.seen==='stale'||found.seen==='old')&&rt&&ownsServer(rt.pid);
  if(killable){
    log('  检测到本数据目录的旧版服务(已核实进程归属),终止并拉起当前版本…');
    try{process.kill(rt.pid);}catch(_){}
    const child=spawn(resolveNode(),[path.join(ROOT,'runtime','server.js')],{cwd:ROOT,env:process.env,windowsHide:true,stdio:'ignore',detached:true});
    child.unref();
    for(let i=0;i<25&&!found.port;i++){await new Promise(r=>setTimeout(r,800));found=await findService();}
  }else if(found.seen==='stale'||found.seen==='old'){
    /* 归属核实不过: 它可能正占着本数据目录, 盲启第二个服务会双写数据 → 如实中止 */
    fail('检测到'+({old:'旧版服务(缺少指纹)',stale:'本数据目录的旧进程'}[found.seen])
      +',但无法核实进程归属,未终止任何进程、也未启动新服务(避免两个服务同写数据目录)。'
      +'请手动结束残留 node 进程后重试;数据不会丢失。');
  }
}
if(!found.port){
  const child=spawn(resolveNode(),[path.join(ROOT,'runtime','server.js')],{cwd:ROOT,env:process.env,windowsHide:true,stdio:'ignore',detached:true});
  child.unref();
  for(let i=0;i<20&&!found.port;i++){await new Promise(r=>setTimeout(r,800));found=await findService();}
}
if(!found.port){
  const what={old:'旧版服务(缺少指纹,无法确认归属)',stale:'本数据目录的旧进程(归属核实未通过)',other:'其他数据目录的实例(不影响,但本实例未能启动)'}[found.seen]||'未知原因';
  fail('服务未能确认。'+what+'。未强行终止任何进程;请手动结束残留 node 进程后重试,数据不会丢失。');
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
