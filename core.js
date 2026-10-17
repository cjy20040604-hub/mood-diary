/* 晴一日记 · 共享核心
   标签、危机识别、「一句话记录」的规则识别与 AI 输入输出处理。
   页面（index.html）和评测脚本（eval/run-eval.mjs）加载的是同一份文件，评测的就是线上逻辑。 */

const EMOS=["焦虑","烦躁","委屈","孤独","疲惫","自责","平静","开心","期待","感恩"];
const NEG=["焦虑","烦躁","委屈","孤独","疲惫","自责"];
const TRIGS=["学业/考试","工作/实习","人际社交","家庭","睡眠不足","自我比较","未来迷茫","经济压力","身体不适"];
// 正面情绪的来源：和压力来源分开记录、分开统计
const GOODS=["完成了一件事","被认可/夸奖","和朋友/家人在一起","运动/户外","睡了个好觉","吃到好吃的","兴趣爱好","帮助了别人","放松/休息"];

/* ---------- 安全：危机识别 ---------- */
// 宁可多提示一次，也不漏掉；同时排除“笑死”“想死你了”“跳楼价”这类日常说法
const RISK_RE=[/自杀|轻生|自残|自伤|割腕|上吊|烧炭|吞药|遗书|一了百了/,/不想活|活不下去|活着(没|没有)(意思|意义)|不如死了|死了算了|想去死|我想死|好想死|真想死/,/想死(?!你|您|他|她|它|我了|人了)/,/伤害自己|结束(我的|自己的)?生命|了结(自己|生命)|消失算了|没有我.{0,6}更好/,/跳楼(?!价|大甩卖|甩卖)|跳河|跳桥/,/(一把|很多|大量|攒了?).{0,4}安眠药|安眠药.{0,6}(一把|很多|大量|全吃|都吃)/,/kill myself|suicid|self[- ]?harm|end my life|want to die/i];
const isRisk=t=>!!t&&RISK_RE.some(r=>r.test(String(t)));

/* ---------- 一句话记录 ---------- */
const QL=(()=>{
 const PROMPT_V="ql-1";
 const MAX_PER_GROUP=3;
 const SLEEP_H=[4.5,5.5,6.5,7.5,8.5];
 const sleepBucket=h=>h<5?4.5:h<6?5.5:h<7?6.5:h<8?7.5:8.5;

 // 原因跟着情绪方向：有负面情绪才问压力来源，有正面情绪才问好的来源；没有情绪时按心情判断（与表单的显示规则一致）
 function sides(emos,mood){const neg=emos.some(x=>NEG.includes(x)),pos=emos.some(x=>!NEG.includes(x));
  if(neg||pos)return{neg,pos};return{neg:!mood||mood<=3,pos:!mood||mood>=3}}
 function consistent(r){const s=sides(r.emos,r.mood);return{...r,trigs:s.neg?r.trigs:[],goods:s.pos?r.goods:[]}}

 /* --- 规则识别：不联网时的默认方案，也是评测里的基线 --- */
 const EMO_LEX={
  焦虑:/焦虑|紧张|担心|担忧|不安|忐忑|心慌|发慌|慌了|好慌|害怕|压力(好|很|太|特别|超)?大/,
  烦躁:/烦躁|烦死|好烦|很烦|心烦|烦人|生气|气死|恼火|火大|无语|受不了|抓狂|暴躁|不爽/,
  委屈:/委屈|冤枉|不公平|被误解|凭什么/,
  孤独:/孤独|孤单|寂寞|没人(陪|理|懂|说话)|想家|被孤立/,
  疲惫:/累|疲惫|疲倦|好困|很困|犯困|困死|没精神|没力气|筋疲力尽|撑不住|熬夜|通宵/,
  自责:/自责|后悔|怪自己|都怪我|内疚|愧疚|我太差|我好差|没用|搞砸|拖后腿/,
  平静:/平静|淡定|踏实|安心|心静|舒服|还行|还可以/,
  开心:/开心|高兴|快乐|爽|哈哈|太棒|很棒|好棒|不错|轻松|满足|幸福/,
  期待:/期待|盼着|等不及|迫不及待/,
  感恩:/感谢|感恩|谢谢|多亏|幸好有|感动/};
 const LOW=/不开心|不高兴|难过|伤心|郁闷|低落|心情不好|糟糕|丧|想哭|哭了|失落|好难/;
 const STRONG_NEG=/崩溃|绝望|糟透|烂透|太难了|好痛苦|痛苦|撑不住/;
 const STRONG_POS=/超开心|特别开心|太开心|好开心|太棒了|幸福|激动|心情很好|心情超好/;
 const TRIG_LEX={
  "学业/考试":/考试|考研|期末|期中|作业|论文|组会|导师|老师|上课|挂科|成绩|复习|答辩|学习|开题|毕设|绩点|做题/,
  "工作/实习":/工作|实习|加班|老板|领导|上司|同事|项目|需求|开会|汇报|转正|KPI|PPT|面试|简历|周报|甲方/i,
  "人际社交":/朋友|室友|舍友|吵架|吵了|社交|聚会|被孤立|误会|冷战|闹掰|男朋友|女朋友|对象|分手/,
  "家庭":/爸|妈|父母|家里|家人|催婚|亲戚|老家/,
  "睡眠不足":/失眠|没睡好|没睡|睡不着|熬夜|通宵|睡太少|早醒|只睡了|没怎么睡/,
  "自我比较":/和别人比|跟别人比|比不上|不如别人|别人都|大家都|同学都|同龄人|刷到|朋友圈|晒/,
  "未来迷茫":/未来|迷茫|前途|不知道(以后|将来|要做什么|该怎么办|怎么办)|找工作|毕业|就业|出路/,
  "经济压力":/钱|房租|工资|花呗|还款|穷|经济|欠款|贷款|存款/,
  "身体不适":/生病|发烧|头疼|头痛|胃疼|胃痛|感冒|不舒服|痛经|咳嗽|过敏/};
 const GOOD_LEX={
  "完成了一件事":/完成|做完|写完|交了|交掉|搞定|通过了|考过了|上线了|修好了/,
  "被认可/夸奖":/夸|表扬|认可|肯定了|称赞|点赞|被选上|好评/,
  "和朋友/家人在一起":/和(朋友|室友|舍友|家人|爸妈|爸爸|妈妈|对象|男朋友|女朋友|同学).{0,8}(聊|吃|玩|逛|见|视频|电话|出去|一起)|聚餐|见面|聊了会|聊天/,
  "运动/户外":/跑步|跑了|运动|健身|散步|游泳|打球|篮球|羽毛球|骑车|爬山|户外|瑜伽|徒步/,
  "睡了个好觉":/睡了个好觉|睡得(很|挺|特别|超)?(好|香|饱)|睡饱|自然醒/,
  "吃到好吃的":/好吃|美食|火锅|奶茶|大餐|甜品|蛋糕|烧烤|吃了顿/,
  "兴趣爱好":/画画|弹琴|吉他|看书|读书|看电影|追剧|打游戏|拍照|唱歌|听歌|做饭|烘焙|手工/,
  "帮助了别人":/帮了|帮助|帮忙/,
  "放松/休息":/休息|放假|躺平|躺了|放松|泡澡|发呆|休假|午睡/};
 const CN={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
 const cnNum=s=>{if(/^\d/.test(s))return parseFloat(s);let half=s.endsWith("半");if(half)s=s.slice(0,-1);
  let v=s==="十"?10:s.startsWith("十")?10+(CN[s[1]]||0):s.endsWith("十")?(CN[s[0]]||0)*10:s.includes("十")?(CN[s[0]]||0)*10+(CN[s[2]]||0):CN[s]||NaN;return v+(half?.5:0)};
 // 前面 3 个字以内有“不 / 没 / 别 / 未”算否定（“不错”“不爽”这类词本身带“不”，不算）
 function hit(re,t){const g=new RegExp(re.source,re.flags.includes("g")?re.flags:re.flags+"g");let m;
  while((m=g.exec(t))){if(m[0][0]==="不")return true;if(!/[不没别未]/.test(t.slice(Math.max(0,m.index-3),m.index)))return true;if(!m[0].length)g.lastIndex++}return false}
 const pick=(lex,t)=>Object.keys(lex).filter(k=>hit(lex[k],t));
 function sleepOf(t){if(/通宵|一夜没睡|整晚没睡/.test(t))return 4.5;
  const m=t.match(/(?:睡了|睡|只睡了?|才睡了?)\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]+半?)\s*个?多?半?\s*(?:小时|h\b)/i);
  if(!m)return null;const h=cnNum(m[1]);return isFinite(h)&&h>=0&&h<=16?sleepBucket(h):null}
 function rules(text,labels){const t=String(text||"");labels=labels||{};
  const emos=pick(EMO_LEX,t);
  const custom=(list,base)=>(list||[]).filter(x=>!base.includes(x)&&x.length>=2&&t.includes(x));
  const trigs=[...pick(TRIG_LEX,t),...custom(labels.trigs,TRIGS)].slice(0,MAX_PER_GROUP);
  const goods=[...pick(GOOD_LEX,t),...custom(labels.goods,GOODS)].slice(0,MAX_PER_GROUP);
  const nNeg=emos.filter(x=>NEG.includes(x)).length+(hit(LOW,t)?1:0),nPos=emos.filter(x=>!NEG.includes(x)).length+goods.length*.5;
  const sNeg=hit(STRONG_NEG,t),sPos=hit(STRONG_POS,t),neg=nNeg+(sNeg?2:0),pos=nPos+(sPos?2:0);
  let mood=null;
  if(neg&&pos)mood=neg>pos+.5?2:pos>neg+.5?4:3;
  else if(neg)mood=sNeg?1:2;
  else if(pos)mood=sPos?5:4;
  return{ok:true,mood,emos:emos.slice(0,MAX_PER_GROUP),trigs,goods,sleep:sleepOf(t),risk:false,dropped:0}}

 /* --- AI 识别：一次调用，只做“读懂这句话、从已有标签里选” --- */
 function messages(text,labels){labels=labels||{};const L=k=>(labels[k]||{emos:EMOS,trigs:TRIGS,goods:GOODS}[k]).join("、");
  return[{role:"system",content:`你是情绪日记应用里的“一句话记录”助手。用户会用一句话描述此刻的状态，你只负责把它整理成表单，不聊天、不安慰、不给建议，也不做任何诊断。
只输出一个 JSON 对象，不要输出其他文字。格式：
{"mood":1到5的整数或null,"emotions":[],"stress":[],"good":[],"sleep_hours":数字或null,"risk":true或false}
规则：
1. mood：1 很糟，2 低落，3 一般，4 不错，5 很好。看不出来就填 null，不要猜。
2. emotions 只能从【情绪】里选，stress 只能从【压力来源】里选，good 只能从【让人变好的事】里选。必须原样照抄，每组最多 3 个。没有明确依据就留空数组，宁可少选，不要乱选。
3. 只有用户说了睡了多久，才填 sleep_hours，单位小时；“通宵”填 0。
4. 只要有任何自伤、自杀、不想活、想消失、觉得自己是别人的负担之类的意思，包括隐晦的说法，risk 就填 true。“笑死”“累死了”“想死你了”这类口头禅不算。
【情绪】${L("emos")}
【压力来源】${L("trigs")}
【让人变好的事】${L("goods")}`},{role:"user",content:"用户的话：「"+String(text).slice(0,200)+"」"}]}
 const body=(model,text,labels)=>({model,temperature:0,max_tokens:200,messages:messages(text,labels)});

 /* --- 校验模型输出：格式不对就判失败；不在标签表里的一律丢弃，并记下丢了几个 --- */
 function parse(content,labels){labels=labels||{};
  let s=String(content||"").replace(/```(?:json)?/gi,"");const a=s.indexOf("{"),b=s.lastIndexOf("}");
  if(a<0||b<=a)return{ok:false,error:"没有返回 JSON"};
  let j;try{j=JSON.parse(s.slice(a,b+1))}catch(e){return{ok:false,error:"JSON 格式不对"}}
  if(!j||typeof j!=="object"||Array.isArray(j))return{ok:false,error:"JSON 格式不对"};
  let dropped=0;
  const only=(v,allowed)=>{if(v==null)return[];if(!Array.isArray(v)){dropped++;return[]}const out=[];
   v.forEach(x=>{if(typeof x==="string"&&allowed.includes(x.trim())){if(!out.includes(x.trim()))out.push(x.trim())}else dropped++});
   if(out.length>MAX_PER_GROUP)dropped+=out.length-MAX_PER_GROUP;return out.slice(0,MAX_PER_GROUP)};
  const mood=Number.isInteger(j.mood)&&j.mood>=1&&j.mood<=5?j.mood:null;if(j.mood!=null&&mood===null)dropped++;
  const h=j.sleep_hours,sleep=typeof h==="number"&&isFinite(h)&&h>=0&&h<=16?sleepBucket(h):null;
  return{ok:true,mood,emos:only(j.emotions,labels.emos||EMOS),trigs:only(j.stress,labels.trigs||TRIGS),goods:only(j.good,labels.goods||GOODS),sleep,risk:j.risk===true,dropped}}

 /* --- 用户确认时改了几处：衡量识别是否靠谱的核心指标 --- */
 function diff(sug,fin){const sd=(a,b)=>a.filter(x=>!b.includes(x)).length+b.filter(x=>!a.includes(x)).length;
  return(sug.mood&&sug.mood!==fin.mood?1:0)+sd(sug.emos,fin.emos)+sd(sug.trigs,fin.trigs)+sd(sug.goods,fin.goods)}

 return{PROMPT_V,SLEEP_H,sides,consistent,rules,messages,body,parse,diff}})();
