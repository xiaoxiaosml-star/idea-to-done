/* 成事工坊 · Claude Code 适配器
 * 用官方无头调用 claude -p,展开随包 Skill,按事项维护独立会话(--resume 续谈)。
 * 全部通过参数数组传值,不拼接 shell 命令。
 * 隔离边界(R03,对照官方 CLI 2.1.214 参数):
 *  --tools            硬限制可用工具集合(不是免询问许可,是"只给这些工具"),
 *                     只允许读方法库白名单目录,模型拿不到 Bash/Edit/Write 等任何写工具;
 *  --setting-sources  只加载 project/local 设置,宿主 user/global 个人配置与 hooks 不进业务调用;
 *  --strict-mcp-config 只认显式 --mcp-config(本适配器不传=无 MCP),宿主 MCP 不注入;
 *  cwd 用数据目录下专属空目录(不放仓库),宿主仓库/上级目录的 CLAUDE.md 记忆链不会被项目级加载;
 *  --add-dir          方法库根,Read 白名单全部落在它下面。
 * 保留: 真实账户登录、随包真实 Skill 调用链(/chengshi-workshop:idea-to-done)、方法正文读取。
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

/* 业务调用专属工作目录: 与仓库隔离的空目录(自动创建),只用于让相对路径/项目级记忆不落到宿主仓库 */
function isolateCwd(){
  const d=path.join(process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop'),'ai-cwd');
  try{fs.mkdirSync(d,{recursive:true});}catch(_){}
  return d;
}

/* 一次真实调用。
 * opts: {prompt, sessionId, cwd, methodsRoot, timeoutMs}
 * 返回 {ok, text, sessionId, turns, costUsd, error}
 */
function callClaude(opts){
  const {prompt,sessionId,methodsRoot}=opts;
  const timeoutMs=opts.timeoutMs||240000;
  /* 离线自测桩: 设置 CHENGSHI_STUB_CLAUDE=<桩JSON文件> 时直接返回桩响应,不发起真实调用。
   * 仅供本仓库自动化测试注入协议块/故障,正常安装与运行从不设置该变量。 */
  if(process.env.CHENGSHI_STUB_CLAUDE){
    try{
      const stub=JSON.parse(fs.readFileSync(process.env.CHENGSHI_STUB_CLAUDE,'utf8'));
      const done=()=>stub.fail
        ?{v:{ok:false,error:stub.error||'stub-fail'}}
        :{v:{ok:true,text:stub.text||'',sessionId:stub.sessionId||sessionId||'stub-session',turns:1,costUsd:0}};
      if(stub.delayMs)return new Promise(res=>setTimeout(()=>res(done().v),stub.delayMs));
      return Promise.resolve(done().v);
    }catch(e){
      return Promise.resolve({ok:false,error:'stub:'+e.message});
    }
  }
  const exe=resolveClaudeExe();
  const mroot=(methodsRoot||'').replace(/\\/g,'/');
  const args=[
    '-p',prompt,
    '--output-format','json',
    '--max-turns','8',
    '--add-dir',methodsRoot,
    '--setting-sources','project,local',
    '--strict-mcp-config',
    '--tools',
      `Read(${mroot}/chapters/**)`,
      `Read(${mroot}/deep-dive/**)`,
      `Read(${mroot}/tools/**)`,
      `Read(${mroot}/skills/**)`,
      `Read(${mroot}/cases/**)`,
      `Read(${mroot}/README.md)`
  ];
  if(sessionId)args.push('--resume',sessionId);
  return new Promise(resolve=>{
    let out='',err='';
    let child;
    try{
      child=spawn(exe,args,{cwd:isolateCwd(),env:process.env,windowsHide:true});
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
