/* 成事工坊 · Claude Code 适配器
 * 用官方无头调用 claude -p,注入随包 Skill 内容,按事项维护独立会话(--resume 续谈)。
 * 全部通过参数数组传值,不拼接 shell 命令。
 * 隔离边界(R03,对照官方 CLI 2.1.214 参数; B2复审后分层落实,工具/文件范围/自动上下文不再混用):
 *  --safe-mode        关闭全部自动加载项: 用户/祖先 CLAUDE.md 记忆、hooks、插件、宿主 MCP、
 *                     自定义命令——登录、内置工具、权限系统照常工作(不用 --bare,不碰登录态);
 *  --tools Read       工具名称集合: 只给 Read 这一个内置工具,模型拿不到 Bash/Edit/Write;
 *  --allowedTools     权限规则: Read 只允许方法库根目录树下,越界读在本机直接被拒——
 *                     是真路径白名单,不靠"碰巧没给工具"假隔离;
 *  --setting-sources project,local  宿主 user/global 个人设置不加载;
 *  --strict-mcp-config 只认显式 --mcp-config(本适配器不传=无 MCP);
 *  cwd 用数据目录下专属空目录; --add-dir 方法库根。
 * 随包 Skill: safe-mode 下技能不自动加载,由本适配器把 skills/idea-to-done/SKILL.md
 * 正文读出显式注入提示词开头——内容与原 Skill 链一致,不删不改。
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

/* 业务调用专属工作目录: 与仓库隔离的空目录(自动创建),只用于让相对路径不落到宿主仓库 */
function isolateCwd(){
  const d=path.join(process.env.CHENGSHI_DATA||path.join(os.homedir(),'.chengshi-workshop'),'ai-cwd');
  try{fs.mkdirSync(d,{recursive:true});}catch(_){}
  return d;
}

/* 随包技能正文注入: safe-mode 禁用技能自动加载,这里显式读出 SKILL.md 内容附在提示词前。
 * 读不到文件时返回空串(调用仍可进行,只是少了技能正文)。 */
const skillCache={};
function loadSkillBlock(methodsRoot){
  const key=methodsRoot||'';
  if(skillCache[key]!==undefined)return skillCache[key];
  let block='';
  try{
    const f=path.join(methodsRoot,'skills','idea-to-done','SKILL.md');
    block='【随包技能 chengshi-workshop:idea-to-done（safe-mode 下显式注入正文，与原 Skill 链一致）】\n'
      +fs.readFileSync(f,'utf8');
  }catch(_){block='';}
  skillCache[key]=block;
  return block;
}

/* 一次真实调用。
 * opts: {prompt, sessionId, cwd, methodsRoot, timeoutMs}
 * 返回 {ok, text, sessionId, turns, costUsd, error}
 */
function callClaude(opts){
  const {prompt,sessionId,methodsRoot}=opts;
  const timeoutMs=opts.timeoutMs||240000;
  /* 离线自测桩: 设置 CHENGSHI_STUB_CLAUDE=<桩JSON文件> 时直接返回桩响应,不发起真实调用。
   * 仅供本仓库自动化测试注入协议块/故障,正常安装与运行从不设置该变量。
   * 附带 CHENGSHI_STUB_CAPTURE=<文件> 时把实际提示词落盘,供断言上下文内容(B4)。 */
  if(process.env.CHENGSHI_STUB_CLAUDE){
    try{
      const stub=JSON.parse(fs.readFileSync(process.env.CHENGSHI_STUB_CLAUDE,'utf8'));
      /* 分步桩: {steps:[...]} 按调用顺序逐步消费(进度写回文件),无 steps 时整体单步,兼容旧格式 */
      let cur=stub;
      if(Array.isArray(stub.steps)){
        cur=stub.steps[stub.__i||0]||{};
        try{fs.writeFileSync(process.env.CHENGSHI_STUB_CLAUDE,JSON.stringify({...stub,__i:(stub.__i||0)+1}));}catch(_){}
      }
      if(process.env.CHENGSHI_STUB_CAPTURE){
        try{fs.writeFileSync(process.env.CHENGSHI_STUB_CAPTURE,JSON.stringify({prompt,sessionId:sessionId||null,at:new Date().toISOString()}));}catch(_){}
      }
      const done=()=>cur.fail
        ?{v:{ok:false,error:cur.error||'stub-fail'}}
        :{v:{ok:true,text:cur.text||'',sessionId:cur.sessionId||sessionId||'stub-session',turns:1,costUsd:0}};
      if(cur.delayMs)return new Promise(res=>setTimeout(()=>res(done().v),cur.delayMs));
      return Promise.resolve(done().v);
    }catch(e){
      return Promise.resolve({ok:false,error:'stub:'+e.message});
    }
  }
  const exe=resolveClaudeExe();
  const mroot=(methodsRoot||'').replace(/\\/g,'/');
  const skill=loadSkillBlock(methodsRoot);
  const fullPrompt=(skill?skill+'\n\n':'')+prompt;    /* 技能正文在最前,与原 Skill 链同序 */
  const args=[
    '-p',fullPrompt,
    '--output-format','json',
    '--max-turns','8',
    '--safe-mode',
    '--tools','Read',
    '--allowedTools','Read('+mroot+'/**)',
    '--setting-sources','project,local',
    '--strict-mcp-config',
    '--add-dir',methodsRoot
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
