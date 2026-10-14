/* 成事工坊 · 共同数据协议校验
 * 两类对象:
 *  1) AI 回复中的协议块 (fenced json): questions / plan / review
 *  2) 落盘记录的基本形状检查 (项目/执行记录/决定)
 */

function isStr(v){return typeof v==='string'&&v.trim().length>0;}
function isArr(v){return Array.isArray(v);}

/* 从 AI 正文中提取协议 JSON: 优先取最后一个 fenced json 块;
 * 兜底用花括号配对扫描裸 {"type":"..."} 对象(模型偶尔不写围栏)。 */
function extractJson(text){
  const re=/```json\s*([\s\S]*?)```/g;let m,last=null;
  while((m=re.exec(text))!==null)last=m[1];
  if(last)return last;
  const start=text.indexOf('{"type"');
  if(start<0)return null;
  let depth=0,inStr=false,esc=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];
    if(esc){esc=false;continue;}
    if(c==='\\'&&inStr){esc=true;continue;}
    if(c==='"')inStr=!inStr;
    if(inStr)continue;
    if(c==='{')depth++;
    else if(c==='}'){depth--;if(depth===0)return text.slice(start,i+1);}
  }
  return null;
}
function parseProtocol(text){
  if(!isStr(text))return {ok:false,error:'empty'};
  const block=extractJson(text);
  if(!block)return {ok:false,error:'no-json-block'};
  let obj;
  try{obj=JSON.parse(block);}catch(e){return {ok:false,error:'json-parse:'+e.message};}
  return validateProtocol(obj);
}

function validateProtocol(obj){
  if(!obj||typeof obj!=='object'||typeof obj.type!=='string')
    return {ok:false,error:'shape'};
  const t=obj.type;
  if(t==='questions'){
    if(!isArr(obj.items)||!obj.items.length||!obj.items.every(isStr))
      return {ok:false,error:'questions.items'};
    return {ok:true,type:t,data:{items:obj.items.map(s=>s.trim())}};
  }
  if(t==='plan'){
    const need=['question','action','accept','budget','stop','evidenceToBring'];
    const miss=need.filter(k=>!isStr(obj[k]));
    if(miss.length)return {ok:false,error:'plan.missing:'+miss.join(',')};
    /* 结构化带入字段(可选, 兼容旧计划): 钱/时间上限必须是清晰非负数字, 拒绝含糊文本, 不猜数 */
    const num=v=>{
      if(typeof v==='number')return isFinite(v)&&v>=0?v:null;
      if(typeof v==='string'&&/^\d+(\.\d+)?$/.test(v.trim()))return Number(v.trim());
      return null;
    };
    let budgetMoney=null,budgetTime=null;
    if(obj.budgetMoney!==undefined&&obj.budgetMoney!==null&&obj.budgetMoney!==''){
      budgetMoney=num(obj.budgetMoney);
      if(budgetMoney===null)return {ok:false,error:'plan.budgetMoney-invalid'};
    }
    if(obj.budgetTime!==undefined&&obj.budgetTime!==null&&obj.budgetTime!==''){
      budgetTime=num(obj.budgetTime);
      if(budgetTime===null)return {ok:false,error:'plan.budgetTime-invalid'};
    }
    return {ok:true,type:t,data:{
      question:obj.question.trim(),action:obj.action.trim(),accept:obj.accept.trim(),
      budget:obj.budget.trim(),stop:obj.stop.trim(),evidenceToBring:obj.evidenceToBring.trim(),
      reason:isStr(obj.reason)?obj.reason.trim():'',methodRef:isStr(obj.methodRef)?obj.methodRef.trim():'',
      budgetMoney,budgetTime,
      continueSignal:isStr(obj.continueSignal)?obj.continueSignal.trim():''
    }};
  }
  if(t==='review'){
    if(!isStr(obj.result))return {ok:false,error:'review.result'};
    if(!isStr(obj.next))return {ok:false,error:'review.next-required'};
    if(!['continue','adjust','pause','stop'].includes(obj.suggest))return {ok:false,error:'review.suggest-invalid'};
    const sug=['continue','adjust','pause','stop'];
    return {ok:true,type:t,data:{
      result:obj.result.trim(),
      assumptionDelta:isStr(obj.assumptionDelta)?obj.assumptionDelta.trim():'',
      stillUnknown:isStr(obj.stillUnknown)?obj.stillUnknown.trim():'',
      next:obj.next.trim(),
      suggest:obj.suggest
    }};
  }
  return {ok:false,error:'unknown-type:'+t};
}

/* 执行记录(证据)形状 */
function validExecution(e){
  return e&&typeof e==='object'&&typeof e.id==='string'&&isStr(e.action)
    &&typeof e.input==='string'&&typeof e.result==='string'
    &&typeof e.evidence==='string'&&typeof e.note==='string'
    &&typeof e.at==='string';
}

/* 决定形状 */
function validDecision(d){
  return d&&typeof d==='object'&&['done','go','pause','stop'].includes(d.type)
    &&typeof d.reason==='string'&&typeof d.at==='string';
}

module.exports={parseProtocol,validateProtocol,validExecution,validDecision};
