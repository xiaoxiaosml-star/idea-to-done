/* 成事工坊 · 启动器
 * 成事工坊.cmd 调它: 服务活着就直接开浏览器; 没在跑就先拉起(隐藏窗口)再开。
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

const health=port=>new Promise(res=>{
  const req=http.get({host:'127.0.0.1',port,path:'/api/health',timeout:1200},r=>{
    let b='';r.on('data',d=>b+=d);r.on('end',()=>res(r.statusCode===200));
  });
  req.on('timeout',()=>{req.destroy();res(false);});
  req.on('error',()=>res(false));
});

(async()=>{
  let port=4310,token=null;
  try{
    const rt=JSON.parse(fs.readFileSync(path.join(DATA,'runtime.json'),'utf8'));
    port=rt.port||4310;token=rt.token;
  }catch(_){}
  if(!await health(port)){
    const child=spawn('node',[path.join(ROOT,'runtime','server.js')],{
      cwd:ROOT,windowsHide:true,stdio:'ignore',detached:true});
    child.unref();
    let up=false;
    for(let i=0;i<25;i++){
      await new Promise(r=>setTimeout(r,800));
      if(await health(port)){up=true;break;}
    }
    if(!up){console.error('[成事工坊] 服务启动失败,请运行 node runtime/server.js 查看报错');process.exit(1);}
    console.log('[成事工坊] 本地服务已拉起: http://127.0.0.1:'+port+'/');
  }
  if(tray)return;                       /* 自启模式: 静默结束 */
  const url='http://127.0.0.1:'+port+'/';
  spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'}).unref();
})();
