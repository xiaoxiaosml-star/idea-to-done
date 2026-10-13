/* 成事工坊 · 启动器
 * 成事工坊.cmd 调它: 服务活着就直接开浏览器; 没在跑就先拉起(隐藏窗口)再开。
 * 健康检查核验本应用身份(service=chengshi-workshop),不把任意 HTTP 200 当本服务;
 * 启动后重读 runtime.json 拿实际端口(服务可能因占用顺延)。
 * --tray: 开机自启模式,只保证服务在跑,不弹浏览器。健康检查不发起模型调用。
 */
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');

const ROOT=path.resolve(__dirname,'..');
const DATA=process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop');
const tray=process.argv.includes('--tray');

function readRt(){
  try{return JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));}
  catch(_){return null;}
}
/* 身份化健康检查: 返回实际可用端口或 null */
function probe(port){
  return new Promise(res=>{
    const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1200},r=>{
      let b='';r.on('data',d=>b+=d);r.on('end',()=>{
        let ok=false;
        try{const j=JSON.parse(b);ok=(j.ok===true&&j.service==='chengshi-workshop');}catch(_){}
        res(ok?port:null);
      });
    });
    req.on('timeout',()=>{req.destroy();res(null);});
    req.on('error',()=>res(null));
  });
}
async function findService(){
  const rt=readRt();
  const first=rt&&rt.port?rt.port:4310;
  let hit=await probe(first);
  if(hit)return hit;
  for(let p=4310;p<=4330;p++){                                /* 端口顺延时扫描 */
    if(p===first)continue;
    hit=await probe(p);
    if(hit)return hit;
  }
  return null;
}

(async()=>{
  let port=await findService();
  if(!port){
    const child=spawn(process.execPath,[path.join(ROOT,'runtime','server.js')],{
      cwd:ROOT,windowsHide:true,stdio:'ignore',detached:true});
    child.unref();
    for(let i=0;i<25&&!port;i++){
      await new Promise(r=>setTimeout(r,800));
      port=await findService();                               /* 每轮重读runtime.json */
    }
    if(!port){console.error('[成事工坊] 服务启动失败,请运行 node runtime/server.js 查看报错');process.exit(1);}
    console.log('[成事工坊] 本地服务已拉起: http://127.0.0.1:'+port+'/');
  }
  if(tray)return;                                             /* 自启模式: 静默结束 */
  spawn('cmd.exe',['/c','start','','http://127.0.0.1:'+port+'/'],{windowsHide:true,stdio:'ignore'}).unref();
})();
