/* 成事工坊 · 启动器
 * 成事工坊.cmd 调它: 服务活着就直接开浏览器; 没在跑就先拉起(隐藏窗口)再开。
 * 健康确认是四元严格核对: 服务身份 + 数据目录指纹(data) + 实例指纹(iid) + 版本。
 * 缺指纹的旧服务不放行; 同数据目录但版本/iid不符的旧进程, 只在命令行核实
 * 它确实是 server.js 之后才终止并重启——不按端口盲目杀进程。
 * --tray: 开机自启模式,只保证服务在跑,不弹浏览器。健康检查不发起模型调用。
 */
const {spawn,spawnSync}=require('child_process');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');
const crypto=require('crypto');

const ROOT=path.resolve(__dirname,'..');
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const tray=process.argv.includes('--tray');
const FP=crypto.createHash('sha1').update(DATA).digest('hex').slice(0,12);   /* 本数据目录指纹 */
const EXPECTED=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,'runtime','version.json'),'utf8')).version;}catch(_){return '';}})();

function readRt(){
  try{return JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));}
  catch(_){return null;}
}
/* 进程归属核实: pid 存在且命令行是成事工坊 server.js(防 pid 复用误杀) */
function ownsServer(pid){
  if(!pid)return false;
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  return /runtime[\\\/]server\.js/.test((r.stdout||'')+(r.stderr||''));
}
function killPid(pid){try{process.kill(pid);}catch(_){}}

/* 健康探测: 返回 'full'(四元全对) | 'stale'(我目录的旧服务) | 'other'(别人的实例) | 'old'(无指纹旧服务) | null(非本服务) */
function classify(port){
  return new Promise(res=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1200},r=>{
      let b='';r.on('data',d=>b+=d);r.on('end',()=>{
        let j=null;try{j=JSON.parse(b);}catch(_){}
        if(!j||j.ok!==true||j.service!=='chengshi-workshop')return res(null);
        if(!j.data||!j.iid)return res('old');                 /* 旧版回包: 缺字段不放行 */
        const rt=readRt();
        if(j.data!==FP)return res('other');                   /* 别的数据目录实例 */
        if(rt&&j.iid!==rt.iid)return res('stale');            /* 指纹对不上=不是本目录的服务 */
        if(EXPECTED&&j.version!==EXPECTED)return res('stale');/* 同目录但版本不符=旧进程 */
        res('full');
      });
    });
    req.on('timeout',()=>{req.destroy();res(null);});
    req.on('error',()=>res(null));
  });
}
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
function spawnServer(){
  const child=spawn(process.execPath,[path.join(ROOT,'runtime','server.js')],{
    cwd:ROOT,windowsHide:true,stdio:'ignore',detached:true});
  child.unref();
}

(async()=>{
  let {port,seen}=await findService();
  if(!port){
    /* 命中旧/可疑服务: 只有命令行核实过进程归属才终止重启;
       核实不过一律如实报错——它可能正占着本数据目录, 盲启第二个服务会双写数据。 */
    const rt=readRt();
    const killable=(seen==='stale'||seen==='old')&&rt&&ownsServer(rt.pid);
    if(killable){
      killPid(rt.pid);
      spawnServer();                                          /* 先终止旧进程再拉新版 */
      for(let i=0;i<25;i++){await new Promise(r=>setTimeout(r,800));
        const f=await findService();if(f.port){port=f.port;break;}}
    }else if(seen==='stale'||seen==='old'){
      console.error('[成事工坊] 检测到'+({old:'旧版服务(缺少指纹)',stale:'本数据目录的旧进程'}[seen])
        +',但无法核实进程归属,未终止也未启动新服务(避免两个服务同写数据目录)。'
        +'请手动结束残留 node 进程后重试;若刚升级,也可直接重启电脑后再双击。');
      process.exit(1);
    }else{
      spawnServer();
      for(let i=0;i<25&&!port;i++){
        await new Promise(r=>setTimeout(r,800));
        const f=await findService();if(f.port){port=f.port;seen=f.seen;}
      }
    }
  }
  if(!port){
    console.error('[成事工坊] 本地服务未能确认,请运行安装器或手动启动 node runtime/server.js 排查。');
    process.exit(1);
  }
  if(tray)return;                                             /* 自启模式: 静默结束 */
  spawn('cmd.exe',['/c','start','','http://127.0.0.1:'+port+'/'],{windowsHide:true,stdio:'ignore'}).unref();
})();
