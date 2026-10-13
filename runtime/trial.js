/* 成事工坊 · 首次小生意验证单 · 计算模块
 * 与 tools/首次小生意验证单.html 的 ledger()/exportMd() 同口径:
 * 金额按分计算; 空=未填, 负/非法=bad; 利润账=营业额-已售成本-其他费用;
 * 工时0→时薪无法计算; 现金账=实际支付-实际收到; 库存并列展示。一单不算赢口径保留。
 */

const IDS=["q1","q2a","q2b","q3","q4","r1","r2","r3","r4","r5","r6","r7","r8","r9","c1","c2","c3"];
const NUM_IDS=["q2a","q2b","r1","r2","r3","r4","r5","r6","r7","r8","r9"];
const INT_IDS=["r1","r2"];   /* 人数/单数: 整数原样,不按分 */

/* 输入归一: 字符串→{s:'ok'|'empty'|'bad', c:分|null} */
function cents(raw){
  if(raw===undefined||raw===null||String(raw).trim()==="")return{s:"empty",c:null};
  const v=Number(String(raw).trim());
  if(!isFinite(v)||v<0)return{s:"bad",c:null};
  return{s:"ok",c:Math.round(v*100)};
}
function yuan(c){return (c/100).toFixed(2)}

/* 校验并归一化整份输入; 返回 {ok, inputs(全字符串), nums, error} */
function normalizeInputs(raw){
  if(!raw||typeof raw!=="object")return{ok:false,error:"inputs-required"};
  const inputs={};
  for(const k of IDS)inputs[k]=String(raw[k]===undefined||raw[k]===null?"":raw[k]).slice(0,2000);
  const nums={};
  for(const k of NUM_IDS){
    if(INT_IDS.includes(k)){                                   /* intOr 口径: parseInt,原值 */
      const raw=inputs[k].trim();
      if(raw===""){nums[k]=null;continue;}
      const v=parseInt(raw,10);
      if(isNaN(v)||v<0||String(v)!==raw.replace(/^0+(?=\d)/,''))return{ok:false,error:"bad-number:"+k};
      nums[k]=v;continue;
    }
    const r=cents(inputs[k]);
    if(r.s==="bad")return{ok:false,error:"bad-number:"+k};
    nums[k]=r.c;
  }
  return{ok:true,inputs,nums};
}

/* 三笔账: 与工具 ledger() 一致 */
function ledger(nums){
  const rev=nums.r3,cogs=nums.r4,fee=nums.r5,h=nums.r6,paid=nums.r8,got=nums.r7,inv=nums.r9;
  if(rev===null||cogs===null||fee===null)return{t:"incomplete"};
  const gross=rev-cogs, profit=gross-fee;
  let cash=null;
  if(paid!==null&&got!==null)cash=paid-got;
  return{t:"ok",gross,profit,h,cash,inv};
}

/* 计算结果转展示文本行(与工具 render() 逐字同口径; 首行用 exportMd 的"触达N人,成交M单"格式) */
function summaryLines(inputs,nums,L){
  const r=ledger(nums);
  const lines=[];
  lines.push("触达："+(nums.r1===null?"?":nums.r1)+" 人，成交 "+(nums.r2===null?"?":nums.r2)+" 单");  /* intOr口径: 12人/2单 整数原样 */
  if(r.t==="incomplete"){
    lines.push("①② 利润账：资料不全，无法计算——营业额、已售商品成本、其他费用三项都要填（不知道的先去查，别按 0 算）。");
    return{lines,r};
  }
  lines.push("① 利润账：营业额 "+yuan(nums.r3)+" - 已售商品成本 "+yuan(nums.r4)+" = 毛利 "+yuan(r.gross)+"；再减其他费用 "+yuan(nums.r5)+" = 净利 "+yuan(r.profit)+" 元");
  if(r.h!==null)lines.push(r.h>0
    ?"② 时间账："+(r.h/100)+" 小时 → 时薪约 "+yuan(Math.round(r.profit/r.h*100))+" 元（跟当地零工价比一比）"
    :"② 时间账：投入工时为 0，时薪无法计算——请核对时间投入是否漏填");
  if(r.cash!==null)lines.push("③ 现金账：实际支付 "+yuan(nums.r8)+" - 实际收到 "+yuan(nums.r7)+" = 现金净流出 "+yuan(r.cash)+" 元");
  else lines.push("③ 现金账：实际收到/实际支付未填齐，无法计算");
  if(r.inv!==null&&r.cash!==null)lines.push("📦 剩余库存成本价值 "+yuan(r.inv)+" 元——货还在你手里，和上面的现金净流出是两笔并列的账");
  if(r.profit>0)lines.push("✅ 净利为正——但一单不算赢，陌生客户连续成交再谈加码");
  else if(r.profit===0)lines.push("➖ 收支持平：没赚也没亏，但时间花掉了——按「支持继续的信号」判断下一步");
  else lines.push("⚠️ 净利为负：营业额高不等于赚钱，先查哪笔账漏了");
  return{lines,r};
}

module.exports={IDS,NUM_IDS,normalizeInputs,ledger,summaryLines};
