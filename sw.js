const CACHE="qingyi-v4";
const SHELL=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:"reload"})))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith("qingyi-")&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
// 页面：网络优先，断网才用缓存（发布后立刻生效）。其余同源资源与字体：先返回缓存，同时后台更新
self.addEventListener("fetch",e=>{
 const r=e.request;if(r.method!=="GET")return;
 const u=new URL(r.url);
 if(u.origin!==location.origin&&!/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname))return;
 if(r.mode==="navigate"){e.respondWith(fetch(r.url,{cache:"no-cache"}).then(res=>{if(res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put("./index.html",cp))}return res}).catch(()=>caches.match("./index.html").then(h=>h||caches.match("./"))));return}
 e.respondWith(caches.open(CACHE).then(async c=>{
  const hit=await c.match(r,{ignoreSearch:true});
  const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==="opaque"))c.put(r,res.clone());return res}).catch(()=>hit);
  return hit||net}))});
// 提醒：页面把提醒设置写入缓存，后台周期同步（仅部分安装版 Chrome 支持）时读取
async function remindIfNeeded(){
 const c=await caches.open("qingyi-prefs"),r=await c.match("prefs");if(!r)return;
 const p=await r.json();if(!p.on)return;
 const now=new Date(),mins=now.getHours()*60+now.getMinutes();
 if(mins<p.min||p.last===now.toDateString())return;
 await self.registration.showNotification("晴一日记",{body:p.text||"花一分钟，记下此刻的心情吧。",icon:"icon-192.png",tag:"daily"});
 p.last=now.toDateString();await c.put("prefs",new Response(JSON.stringify(p)))}
self.addEventListener("periodicsync",e=>{if(e.tag==="qy-remind")e.waitUntil(remindIfNeeded())});
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:"window"}).then(l=>l.length?l[0].focus():self.clients.openWindow("./index.html")))});
