/* 成事工坊 · 启动器
 * 成事工坊.cmd 调它: 服务活着就直接开浏览器; 没在跑就先拉起(隐藏窗口)再开。
 * 健康确认是五元严格核对: 服务身份 + 数据目录指纹(data) + 实例指纹(iid)
 * + 版本 + 安装来源指纹(root=启动服务的安装目录)。
 * 缺指纹的旧服务不放行; 同数据目录但版本/iid/来源不符的旧进程, 只在四重链式核实
 * (rt记录来源根 → 健康回包来源指纹 → 回包pid=rt.pid → pid命令行脚本绝对路径)
 * 之后才终止;
 * 终止失败或旧进程不退出一律如实报错, 不另启第二个服务(同DATA双服务=双写数据)。
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
const norm=p=>path.resolve(p).replace(/\\/g,'/').toLowerCase();   /* 归一化口径与 server.js 一致 */
const FP=crypto.createHash('sha1').update(DATA).digest('hex').slice(0,12);        /* 本数据目录指纹 */
const ROOT_FP=crypto.createHash('sha1').update(norm(ROOT)).digest('hex').slice(0,12); /* 本安装来源指纹 */
const EXPECTED=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,'runtime','version.json'),'utf8')).version;}catch(_){return '';}})();
const FPof=p=>crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0,12);

function readRt(){
  try{return JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));}
  catch(_){return null;}
}
/* 按 Windows 命令行参数边界解析(引号保护空格, 空白分参), 区分可执行文件与脚本参数 */
function parseCmdLine(s){
  const args=[];let cur='',q=null;
  for(const ch of s){
    if(q){if(ch===q)q=null;else cur+=ch;}
    else if(ch==='"'||ch==="'")q=ch;
    else if(/\s/.test(ch)){if(cur){args.push(cur);cur='';}}
    else cur+=ch;
  }
  if(cur)args.push(cur);
  return args;
}
/* 进程归属核实(三重比对, 防 pid 复用误杀别的项目的同名 runtime/server.js):
   1) CIM 调用本身成功; 2) 只从 stdout 解析命令行(stderr 里的文本不放行), 按参数边界
   取脚本参数(全串必须恰好一个 server.js 参数, 无引号双路径/带引号空格都要对);
   3) 归一化后与"期望安装根"下的 runtime/server.js 精确相等。 */
function ownsServer(pid,expectedRoot){
  if(!pid||!expectedRoot)return false;
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    {encoding:'utf8',windowsHide:true,timeout:8000});
  if(r.error||r.status!==0||!r.stdout)return false;
  const scripts=parseCmdLine(r.stdout).filter(a=>/[\\/]runtime[\\/]server\.js$/.test(a));
  if(scripts.length!==1)return false;
  return norm(scripts[0])===norm(path.join(expectedRoot,'runtime','server.js'));
}
/* 终止并确认退出: kill 被拒或旧进程超时未退都返回错误串, 调用方不得再启动新服务 */
const pause=ms=>{const e=Date.now()+ms;while(Date.now()<e);};
function killAndConfirm(pid){
  try{process.kill(pid);}
  catch(e){return '终止请求被拒('+(e.code||e.message)+')';}
  for(let i=0;i<20;i++){
    const t=spawnSync('tasklist',['/FI','PID eq '+pid,'/NH'],{encoding:'utf8',windowsHide:true});
    if(t.error||t.status!==0)return '无法确认旧进程是否退出(tasklist 调用失败)';
    if(!((t.stdout||'')+(t.stderr||'')).includes(String(pid)))return null;   /* 已退出 */
    pause(400);
  }
  return '旧进程未在时限内退出';
}

/* 健康探测: full(五元全对)|srclash(同DATA同版本但来源目录不符)|stale(我目录的旧服务)
 * |other(别的数据目录)|old(缺任一指纹的旧服务)|null(非本服务) */
function classify(port){
  return new Promise(res=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1200},r=>{
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
}
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
function spawnServer(){
  const child=spawn(process.execPath,[path.join(ROOT,'runtime','server.js')],{
    cwd:ROOT,windowsHide:true,stdio:'ignore',detached:true});
  child.unref();
}

(async()=>{
  let {port,seen,body}=await findService();
  let spawned=false;
  if(!port){
    const rt=readRt();
    /* 可终止重启(四重链式核实, 缺一不可): seen=stale/srclash + rt 记录来源根
     * + 健康回包来源指纹与 rt 一致 + 回包进程就是 rt.pid(防同目录双DATA实例残留错指)
     * + pid 的命令行脚本路径与 rt 记录来源精确相等 */
    const okKill=(seen==='stale'||seen==='srclash')&&rt&&rt.root
      &&body&&body.root===FPof(rt.root)&&body.pid===rt.pid&&ownsServer(rt.pid,rt.root);
    if(okKill){
      const kerr=killAndConfirm(rt.pid);
      if(kerr){
        console.error('[成事工坊] 检测到本数据目录的旧服务(归属已核实),但'+kerr
          +'。未启动新服务(避免两个服务同写数据目录)。请手动处理后再试;数据不会丢失。');
        process.exit(1);
      }
      spawnServer();spawned=true;                               /* 旧进程已确认退出才拉新版 */
      for(let i=0;i<25;i++){await new Promise(r2=>setTimeout(r2,800));
        const f=await findService();if(f.port){port=f.port;break;}}
    }else if(seen==='old'||seen==='stale'||seen==='srclash'){
      console.error('[成事工坊] 检测到'+({old:'旧版服务(缺少指纹)',stale:'本数据目录的旧进程',
        srclash:'其他安装目录的同版本服务',other:'其他数据目录的实例'}[seen]||'未知占用')
        +',但无法可靠核实进程归属与安装来源,未终止任何进程、也未启动新服务(避免两个服务同写数据目录)。'
        +'请手动结束残留 node 进程后重试;若刚升级,也可重启电脑后再双击。');
      process.exit(1);
    }
  }
  if(!port&&!spawned){                                         /* 只剩"没服务/只有别人DATA的实例"才全新启动 */
    spawnServer();spawned=true;
    for(let i=0;i<25&&!port;i++){
      await new Promise(r2=>setTimeout(r2,800));
      const f=await findService();if(f.port){port=f.port;seen=f.seen;}
    }
  }
  if(!port){
    console.error('[成事工坊] 本地服务未能确认(已启动一次但健康检查未通过,未再次启动)。'
      +'请运行安装器或手动执行 node runtime/server.js 排查。');
    process.exit(1);
  }
  if(tray)return;                                             /* 自启模式: 静默结束 */
  spawn('cmd.exe',['/c','start','','http://127.0.0.1:'+port+'/'],{windowsHide:true,stdio:'ignore'}).unref();
})();
