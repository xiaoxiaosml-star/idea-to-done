/* 成事工坊 · Claude Code 适配器
 * 用官方无头调用 claude -p,展开随包 Skill,按事项维护独立会话(--resume 续谈)。
 * 全部通过参数数组传值,不拼接 shell 命令;只监听授权目录的读取权限。
 */
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
const os=require('os');

/* 定位宿主可执行文件:优先显式配置,其次常见安装位置 */
function resolveClaudeExe(){
  if(process.env.CLAUDE_CODE_EXE&&fs.existsSync(process.env.CLAUDE_CODE_EXE))
    return process.env.CLAUDE_CODE_EXE;
  const cand=[
    path.join(os.homedir(),'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    '/usr/local/bin/claude','/opt/homebrew/bin/claude'
  ];
  for(const c of cand)if(fs.existsSync(c))return c;
  return 'claude'; /* PATH 兜底 */
}

/* 一次真实调用。
 * opts: {prompt, sessionId, cwd, methodsRoot, timeoutMs}
 * 返回 {ok, text, sessionId, turns, costUsd, error}
 */
function callClaude(opts){
  const {prompt,sessionId,cwd,methodsRoot}=opts;
  const timeoutMs=opts.timeoutMs||240000;
  const exe=resolveClaudeExe();
  const mroot=(methodsRoot||'').replace(/\\/g,'/');
  const args=[
    '-p',prompt,
    '--output-format','json',
    '--max-turns','8',
    '--add-dir',methodsRoot,
    '--allowedTools',
      `Read(${mroot}/chapters/**)`,
      `Read(${mroot}/deep-dive/**)`,
      `Read(${mroot}/tools/**)`,
      `Read(${mroot}/skills/**)`,
      `Read(${mroot}/README.md)`
  ];
  if(sessionId)args.push('--resume',sessionId);
  return new Promise(resolve=>{
    let out='',err='';
    let child;
    try{
      child=spawn(exe,args,{cwd,env:process.env,windowsHide:true});
    }catch(e){
      return resolve({ok:false,error:'spawn:'+e.message});
    }
    const timer=setTimeout(()=>{
      try{child.kill();}catch(_){}
      resolve({ok:false,error:'timeout',text:out});
    },timeoutMs);
    child.stdout.on('data',d=>out+=d.toString());
    child.stderr.on('data',d=>err+=d.toString());
    child.on('error',e=>{
      clearTimeout(timer);
      resolve({ok:false,error:'proc:'+e.message});
    });
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0&&!out.trim()){
        return resolve({ok:false,error:'exit-'+code+' '+(err||'').slice(0,300)});
      }
      const line=[...out.split(/\r?\n/)].reverse().find(l=>l.trim().startsWith('{'));
      if(!line)return resolve({ok:false,error:'no-json-line',text:out.slice(0,500),rawErr:err.slice(0,300)});
      let d;
      try{d=JSON.parse(line);}catch(e){
        return resolve({ok:false,error:'json:'+e.message,text:out.slice(0,500)});
      }
      if(d.is_error)return resolve({ok:false,error:'cli-error:'+(d.result||'').slice(0,300),sessionId:d.session_id});
      resolve({
        ok:true,
        text:(d.result||'').toString(),
        sessionId:d.session_id||sessionId||null,
        turns:d.num_turns||0,
        costUsd:d.total_cost_usd||0
      });
    });
  });
}

module.exports={callClaude,resolveClaudeExe};
