/* 成事工坊 · 一键安装器 (Windows 首发)
 * 职责: 检测前提(node+已登录的Claude Code)→ 注册并安装插件 → 准备数据目录
 *       → 生成启动器与快捷方式 → 启动服务并健康检查(健康检查不发起模型调用)。
 * 重复执行=更新: 不动用户数据,只刷新插件与组件。任何一步失败即中止并报真实原因。
 */
const {spawnSync,execFileSync}=require('child_process');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');

const ROOT=path.resolve(__dirname,'..');
const APP_NAME='成事工坊';
const PLUGIN='chengshi-workshop';
const MARKET='chengshi-workshop-local';
const DATA=path.join(os.homedir(),'.chengshi-workshop');
const LOG=path.join(DATA,'install.log');
const MIN_CLAUDE='2.0.0';

const log=(...a)=>{const s=a.join(' ');console.log(s);fs.mkdirSync(DATA,{recursive:true});fs.appendFileSync(LOG,'['+new Date().toISOString()+'] '+s+'\n');};
const fail=(msg)=>{log('✘ '+msg);log('安装中止。已完成的步骤保留,修好上面这个问题后重新运行本安装器即可。');process.exit(1);};
function run(cmd,args,opts={}){
  const r=spawnSync(cmd,args,{encoding:'utf8',windowsHide:true,...opts});
  return {code:r.status,out:(r.stdout||'')+(r.stderr||''),err:r.error};
}
function sh(quoted){
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',quoted],{encoding:'utf8',windowsHide:true});
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
  if(a[0]<b[0]||(a[0]===b[0]&&a[1]<b[1]))log('  ⚠ 已验证的最低版本为 '+MIN_CLAUDE+',当前 '+mv+' 可能不兼容,继续但请留意');}

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
const mList=run(claudeExe,['plugin','marketplace','list']).out;
if(mList.includes(MARKET))log('  分发目录已存在,跳过注册');
else{
  const r=run(claudeExe,['plugin','marketplace','add',ROOT]);
  if(r.code!==0||!r.out.includes('uccess'))fail('注册分发目录失败: '+r.out.slice(0,300));
  log('  已注册 '+MARKET);
}
log('⑤ 安装/更新插件…');
const pList=run(claudeExe,['plugin','list']).out;
if(pList.includes(PLUGIN)&&!pList.split(PLUGIN)[1].slice(0,200).includes('disabled')){
  log('  插件已安装且启用,执行更新…');
  run(claudeExe,['plugin','marketplace','update',MARKET]);
  run(claudeExe,['plugin','install',PLUGIN+'@'+MARKET]);
}else{
  const r=run(claudeExe,['plugin','install',PLUGIN+'@'+MARKET]);
  if(r.code!==0&&!r.out.includes('uccess'))fail('安装插件失败: '+r.out.slice(0,300));
  run(claudeExe,['plugin','enable',PLUGIN+'@'+MARKET]);
}
log('  插件就绪 ✔');

/* ---- 2. 数据目录与安装清单 ---- */
log('⑥ 准备数据目录(与插件缓存分离,更新不清空)…');
fs.mkdirSync(path.join(DATA,'projects'),{recursive:true});
fs.writeFileSync(path.join(DATA,'install.json'),JSON.stringify({
  installedAt:new Date().toISOString(),version:'0.1.0-stage1',
  root:ROOT,minClaude:MIN_CLAUDE,claudeFound:verOut
},null,2));

/* ---- 3. 启动器 + 快捷方式 ---- */
log('⑦ 生成启动器与快捷方式…');
const launcher=path.join(ROOT,'成事工坊.cmd');
fs.writeFileSync(launcher,
'@echo off\r\nchcp 65001 >nul\r\nset ROOT=%~dp0\r\n' +
'set NODE=node\r\nif exist "%ROOT%installer\\runtime\\node\\node.exe" set NODE="%ROOT%installer\\runtime\\node\\node.exe"\r\n' +
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
/* 开机自启(启动器本身幂等: 服务已在就不重复起) */
const startup=path.join(os.homedir(),'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup');
if(fs.existsSync(startup)){
  const sp=[
    '$ws=New-Object -ComObject WScript.Shell;',
    '$s=$ws.CreateShortcut("'+path.join(startup,APP_NAME+'.lnk').replace(/\\/g,'\\\\')+'");',
    '$s.TargetPath="'+launcher.replace(/\\/g,'\\\\')+'";',
    '$s.Arguments="--tray";',
    '$s.WorkingDirectory="'+ROOT.replace(/\\/g,'\\\\')+'";',
    '$s.Save()'
  ].join('');
  sh(sp);
  log('  已加入开机自启(只拉起本地服务,不弹窗) ✔');
}

/* ---- 4. 启动服务 + 健康检查(无模型调用) ---- */
log('⑧ 启动本地服务并健康检查…');
const health=()=>new Promise(res=>{
  let port=4310;
  try{port=JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8')).port||4310;}catch(_){}
  const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1500},r=>{
    let b='';r.on('data',d=>b+=d);r.on('end',()=>res({ok:r.statusCode===200,port,body:b}));
  });
  req.on('timeout',()=>{req.destroy();res({ok:false,port});});
  req.on('error',()=>res({ok:false,port}));
});
let h=await health();
if(!h.ok){
  const detach=spawnSync('cmd.exe',['/c','start','','/min','node',path.join(ROOT,'runtime','server.js')],{cwd:ROOT,windowsHide:true});
  for(let i=0;i<20&&!h.ok;i++){await new Promise(r=>setTimeout(r,800));h=await health();}
}
if(!h.ok)fail('服务未能启动。请手动运行: node runtime/server.js 查看报错');
log('  服务健康 ✔ http://127.0.0.1:'+h.port+'/');

log('═══ 安装完成 ═══');
log('日常用法: 双击桌面「成事工坊」→ 开始或继续一件事。');
log('数据目录: '+DATA+'(更新插件不会清空它)');
log('安装日志: '+LOG);
process.exit(0);
})().catch(e=>{fail('未捕获异常: '+(e&&e.message||e));});
