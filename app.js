
import { firebaseConfig } from "./firebase-config.js";

const DEF={normalStart:"08:00",normalEnd:"17:00",saturdayEnd:"12:00",lunchStart:"12:00",lunchEnd:"13:00",nightStart:"00:00",nightEnd:"06:00",normalRate:10,otRate:15,nightRate:18};
const S={mode:"demo",user:null,role:"staff",settings:{...DEF},lorries:[],holidays:[],entries:[],activeLorryId:"",page:0,cursors:[null],recordMode:"all",reportRows:[],reportSummaryRows:[],fb:null};
const $=id=>document.getElementById(id), pad=n=>String(n).padStart(2,"0"), money=n=>"RM "+Number(n||0).toLocaleString("en-MY",{minimumFractionDigits:2,maximumFractionDigits:2});
const dk=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()), mk=d=>d.getFullYear()+"-"+pad(d.getMonth()+1);
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const configured=()=>firebaseConfig.apiKey&&!firebaseConfig.apiKey.startsWith("PASTE_")&&firebaseConfig.projectId&&!firebaseConfig.projectId.startsWith("PASTE_");
function mins(t){const a=t.split(":").map(Number);return a[0]*60+a[1]}
function parse(date,time){const a=date.split("-").map(Number),b=time.split(":").map(Number);return new Date(a[0],a[1]-1,a[2],b[0],b[1],0,0)}
function fmtD(d){return d.toLocaleDateString([],{day:"numeric",month:"short",year:"numeric"})}
function fmtT(d){return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}
function night(m,s){const a=mins(s.nightStart),b=mins(s.nightEnd);return a<=b?(m>=a&&m<b):(m>=a||m<b)}
function cat(d,publicHolidayEntitled=false){
  const day=d.getDay(),m=d.getHours()*60+d.getMinutes();

  // Only three pay buckets:
  // Night Shift > OT > Normal
  if(night(m,S.settings))return "night";
  if(publicHolidayEntitled && S.holidays.some(h=>h.date===dk(d)))return "ot";
  if(day===0)return "ot";

  const normalStart=mins(S.settings.normalStart);
  const normalEnd=day===6?mins(S.settings.saturdayEnd):mins(S.settings.normalEnd);
  if(m<normalStart || m>=normalEnd)return "ot";

  const lunchStart=mins(S.settings.lunchStart),lunchEnd=mins(S.settings.lunchEnd);
  if(day>=1 && day<=5 && m>=lunchStart && m<lunchEnd)return "ot";

  return "normal";
}
function rate(c){return {normal:S.settings.normalRate,ot:S.settings.otRate,night:S.settings.nightRate}[c]||0}
function label(c){return {normal:"Normal",ot:"OT",night:"Night Shift"}[c]||c}
function resolve(date,a,b){
  const start=parse(date,a),end0=parse(date,b);
  if(start.getTime()===end0.getTime())throw Error("Start and end cannot be the same.");
  const end=new Date(end0); if(end<start)end.setDate(end.getDate()+1);
  return {start,end,overnight:dk(start)!==dk(end)};
}
function calc(start,end,publicHolidayEntitled=false){
  const totals={normal:0,ot:0,night:0,total:0,amount:0},segments=[];
  let cur=new Date(start),guard=0;
  while(cur<end&&guard<2200){
    const nx=new Date(Math.min(cur.getTime()+60000,end.getTime())),c=cat(cur,publicHolidayEntitled),h=(nx-cur)/3600000,date=dk(cur);
    totals[c]+=h;totals.total+=h;totals.amount+=h*rate(c);
    const p=segments[segments.length-1];
    if(p&&p.category===c&&p.date===date&&p.end===cur.toISOString())p.end=nx.toISOString();
    else segments.push({date,category:c,start:cur.toISOString(),end:nx.toISOString()});
    cur=nx;guard++;
  }
  Object.keys(totals).forEach(k=>totals[k]=Number(totals[k].toFixed(2)));
  return {totals,segments};
}
function demo(){
  S.mode="demo";S.user={uid:"demo",displayName:"Demo Manager"};S.role="manager";
  S.lorries=[{id:"l1",plate:"JAA 1234"},{id:"l2",plate:"JBB 5678"}];
  S.activeLorryId="l1";S.entries=[];showShell();
}
async function initFirebase(){
  const [A,U,F]=await Promise.all([
    import("https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js")
  ]);
  const app=A.initializeApp(firebaseConfig),auth=U.getAuth(app),db=F.getFirestore(app);S.fb={...U,...F,auth,db};
  U.onAuthStateChanged(auth,async user=>{
    if(!user){showLogin();return}
    S.mode="firebase";S.user=user;
    try{
      const ref=F.doc(db,"users",user.uid),snap=await F.getDoc(ref);
      if(!snap.exists())throw Error("Account is not authorised for this system.");
      const profile=snap.data();
      S.role=profile.role||"";
      if(!["manager","staff"].includes(S.role))throw Error("Account role is missing or not authorised.");
      if(profile.status!=="active")throw Error("Account is not active.");
      if(profile.uid && profile.uid!==user.uid)throw Error("Account profile does not match this signed-in user.");
      await masters();
      $("setupBanner").classList.add("hidden");
      showShell();
    }catch(err){
      console.error("Post-login startup error:",err);
      $("setupBanner").classList.remove("hidden");
      $("setupBanner").innerHTML="<strong>Signed in, but app data could not load.</strong><br>"+esc((err?.code?err.code+": ":"")+(err?.message||"Unknown Firestore error"));
      showLogin();
      $("loginError").textContent="Authentication succeeded, but Firestore startup failed.";
      $("loginError").classList.remove("hidden");
    }
  });
}
async function col(name){const f=S.fb,s=await f.getDocs(f.collection(f.db,name));return s.docs.map(d=>({id:d.id,...d.data()}))}
async function masters(){
  const f=S.fb;
  const loadNamed=async(name,fn)=>{
    try{return await fn()}
    catch(err){
      err.message=name+": "+err.message;
      throw err;
    }
  };
  const r=await Promise.all([
    loadNamed("lorries",()=>col("lorries")),
    loadNamed("holidays",()=>col("holidays")),
    loadNamed("settings/global",()=>f.getDoc(f.doc(f.db,"settings","global")))
  ]);
  S.lorries=r[0];S.holidays=r[1];S.settings={...DEF,...(r[2].exists()?r[2].data():{})};
  S.activeLorryId=localStorage.getItem("drivers.activeLorry")||S.lorries[0]?.id||"";
}
function showLogin(){$("loginView").classList.remove("hidden");$("shell").classList.add("hidden")}
function showShell(){
  $("loginView").classList.add("hidden");$("shell").classList.remove("hidden");
  $("userArea").innerHTML="<strong>"+esc(S.user.displayName||S.user.email||"User")+"</strong>";
  $("roleBadge").textContent=S.role.charAt(0).toUpperCase()+S.role.slice(1);
  document.querySelectorAll("[data-role]").forEach(x=>x.classList.toggle("hidden",!x.dataset.role.split(",").includes(S.role)));
  selectors();settingsUI();resetEntryRows();records();report()
}
function options(items,key,label,first){
  return (first?'<option value="">'+esc(first)+'</option>':"")+items.map(x=>'<option value="'+esc(x[key]||x.id)+'">'+esc(x[label])+'</option>').join("");
}
function selectors(){
  $("activeLorry").innerHTML=options(S.lorries,"id","plate","Select lorry");$("activeLorry").value=S.activeLorryId;
  $("recordLorry").innerHTML=options(S.lorries,"id","plate","All lorries");
  $("reportLorry").innerHTML=options(S.lorries,"id","plate","All lorries");
  const now=new Date();
  $("entryDateLabel").textContent="Add one or more work periods for the selected lorry.";
  $("dayTypeBadge").textContent="Batch Entry";
  if(!$("recordMonth").value)$("recordMonth").value=mk(now);
  if(!$("reportMonth").value)$("reportMonth").value=mk(now);
}
function entryRowTemplate(values={},showPH=false){
  const date=values.date||dk(new Date()),start=values.start||"",end=values.end||"",ph=!!values.ph;
  return '<div class="entry-row" data-ph="'+(showPH?'1':'0')+'">'+
    '<label><span class="mobile-label">Date</span><input class="row-date" type="date" value="'+esc(date)+'" required></label>'+
    '<label><span class="mobile-label">Start</span><input class="row-start" type="time" step="60" value="'+esc(start)+'" required></label>'+
    '<label><span class="mobile-label">End</span><input class="row-end" type="time" step="60" value="'+esc(end)+'" required></label>'+
    (showPH?'<label class="ph-cell"><input class="row-ph" type="checkbox" '+(ph?'checked':'')+'><span>Public Holiday entitlement</span></label>':'<span></span>')+
    '<button class="secondary remove-entry-row" type="button" aria-label="Remove entry">×</button>'+
  '</div>';
}
function refreshEntryRows(){
  const rows=[...$("entryRows").querySelectorAll(".entry-row")];
  rows.forEach(r=>r.querySelector(".remove-entry-row").classList.toggle("hidden",rows.length===1));
}
function addEntryRow(values={},showPH=true){
  $("entryRows").insertAdjacentHTML("beforeend",entryRowTemplate(values,showPH));
  refreshEntryRows();
}
function resetEntryRows(){
  $("entryRows").innerHTML="";
  addEntryRow({},true);
}
function readEntryRows(){
  return [...$("entryRows").querySelectorAll(".entry-row")].map((row,i)=>{
    const date=row.querySelector(".row-date").value;
    const start=row.querySelector(".row-start").value;
    const end=row.querySelector(".row-end").value;
    if(!date||!start||!end)throw Error("Complete Date, Start and End for row "+(i+1)+".");
    const t=resolve(date,start,end);
    return {row:i+1,date,startTime:start,endTime:end,publicHolidayEntitled:!!row.querySelector(".row-ph")?.checked,...t};
  }).sort((a,b)=>a.start-b.start);
}
async function existingEntriesForDates(lorryId,dates){
  if(S.mode==="demo")return S.entries.filter(x=>x.status!=="void"&&x.lorryId===lorryId&&dates.includes(x.workDate));
  const f=S.fb,out=new Map();
  for(const date of dates){
    const start=parse(date,"00:00"),end=new Date(start);end.setDate(end.getDate()+2);
    const snap=await f.getDocs(f.query(
      f.collection(f.db,"workEntries"),
      f.where("originalStart",">=",start.toISOString()),
      f.where("originalStart","<",end.toISOString()),
      f.orderBy("originalStart","asc")
    ));
    snap.docs.forEach(d=>{
      const x={id:d.id,...d.data()};
      if(x.status!=="void"&&x.lorryId===lorryId)out.set(d.id,x);
    });
  }
  return [...out.values()];
}
async function submit(e){
  e.preventDefault();
  if(!S.activeLorryId)return alert("Select the active lorry first.");
  const button=e.submitter||e.target.querySelector('button[type="submit"]');
  if(button?.disabled)return;
  let rows;
  try{rows=readEntryRows()}catch(err){return alert(err.message)}
  for(let i=0;i<rows.length;i++){
    for(let j=i+1;j<rows.length;j++){
      if(rows[i].start<rows[j].end&&rows[i].end>rows[j].start){
        return alert("Entry rows "+rows[i].row+" and "+rows[j].row+" overlap. Adjust the times before submitting.");
      }
    }
  }
  if(button)button.disabled=true;
  try{
    const dates=[...new Set(rows.map(r=>r.date))];
    const existing=await existingEntriesForDates(S.activeLorryId,dates);
    for(const r of rows){
      const clash=existing.find(x=>{
        const a=new Date(x.correctedStart||x.originalStart),b=new Date(x.correctedEnd||x.originalEnd);
        return r.start<b&&r.end>a;
      });
      if(clash)return alert("Row "+r.row+" overlaps an existing work entry for this lorry. Check Records before submitting.");
    }
    const lorryPlate=S.lorries.find(x=>x.id===S.activeLorryId)?.plate||"";
    const counts={};
    for(const date of dates)counts[date]=existing.filter(x=>x.workDate===date).length;

    if(S.mode==="firebase"){
      const f=S.fb,batch=f.writeBatch(f.db);
      for(const r of rows){
        counts[r.date]=(counts[r.date]||0)+1;
        const shiftNo=counts[r.date],c=calc(r.start,r.end,r.publicHolidayEntitled);
        const id=S.activeLorryId+"_"+r.start.getTime()+"_"+r.end.getTime();
        const ref=f.doc(f.db,"workEntries",id);
        batch.set(ref,{lorryId:S.activeLorryId,lorryPlate,shiftNo,shiftLabel:"Shift "+shiftNo,originalStart:r.start.toISOString(),originalEnd:r.end.toISOString(),originalStartTime:r.startTime,originalEndTime:r.endTime,workDate:r.date,overnight:r.overnight,publicHolidayEntitled:r.publicHolidayEntitled,status:"pending",totals:c.totals,segments:c.segments,createdBy:S.user.uid,submittedAt:f.serverTimestamp()});
      }
      await batch.commit();
    }else{
      for(const r of rows){
        counts[r.date]=(counts[r.date]||0)+1;
        const shiftNo=counts[r.date],c=calc(r.start,r.end,r.publicHolidayEntitled);
        S.entries.unshift({id:String(Date.now())+"_"+r.row,lorryId:S.activeLorryId,lorryPlate,shiftNo,shiftLabel:"Shift "+shiftNo,originalStart:r.start.toISOString(),originalEnd:r.end.toISOString(),originalStartTime:r.startTime,originalEndTime:r.endTime,workDate:r.date,overnight:r.overnight,publicHolidayEntitled:r.publicHolidayEntitled,status:"pending",totals:c.totals,segments:c.segments,createdBy:S.user.uid,submittedAt:new Date().toISOString()});
      }
    }
    resetEntryRows();
    alert(rows.length+" entr"+(rows.length===1?"y":"ies")+" submitted.");
    await records();
  }finally{
    if(button)button.disabled=false;
  }
}
const ln=(id,fallback="")=>S.lorries.find(x=>x.id===id)?.plate||fallback||"Unknown lorry";
function table(rows){
  if(!rows.length)return '<div style="padding:18px" class="muted">No matching records.</div>';
  const arrow=$("recordSort")?.value==="asc"?"↑":"↓";
  const manager=S.role==="manager";
  const selectHead=manager?'<th class="select-col"><input id="selectVisibleRecords" type="checkbox" aria-label="Select reviewable records on this page"></th>':"";
  const actionHead=manager?"<th>Review</th>":"";
  return "<table><thead><tr>"+selectHead+"<th>Date "+arrow+"</th><th>Lorry</th><th>Shift</th><th>Start</th><th>End</th><th>Hours</th><th>Status</th>"+actionHead+"</tr></thead><tbody>"+
  rows.map(x=>{
    const a=new Date(x.correctedStart||x.originalStart),b=new Date(x.correctedEnd||x.originalEnd);
    const corrected=x.correctedStart?" · corrected":"";
    const endDisplay=(x.correctedOvernight??x.overnight)?fmtD(b)+" "+fmtT(b):fmtT(b);
    const status=x.status||"pending";
    const reviewable=status!=="checked"&&status!=="void";
    const selectCell=manager?'<td class="select-col">'+(reviewable?'<input class="record-select" type="checkbox" value="'+esc(x.id)+'" aria-label="Select '+esc(ln(x.lorryId,x.lorryPlate))+' '+esc(fmtD(a))+'">':"")+"</td>":"";
    let actions="";
    if(manager){
      const mark=status==="checked"?"":'<button class="record-action" data-status="checked">Mark Checked</button>';
      const correct='<button class="record-action" data-correct="1">'+(x.correctedStart?"Edit Correction":"Correct Entry")+'</button>';
      const correction=status==="correction"?"":'<button class="record-action" data-status="correction">Correction Required</button>';
      const voidBtn='<button class="record-action danger-link" data-void="1">Void Entry</button>';
      actions='<td><div class="record-actions" data-id="'+esc(x.id)+'">'+mark+correct+correction+voidBtn+'</div></td>';
    }
    return "<tr data-record-id='"+esc(x.id)+"'>"+selectCell+"<td>"+esc(fmtD(a))+"</td><td>"+esc(ln(x.lorryId,x.lorryPlate))+"</td><td>"+esc(x.shiftLabel||("Shift "+(x.shiftNo||"?")))+"</td><td>"+esc(fmtT(a))+"</td><td>"+esc(endDisplay)+"</td><td>"+Number(x.totals?.total||0).toFixed(2)+"</td><td>"+esc(status+corrected)+"</td>"+actions+"</tr>"
  }).join("")+"</tbody></table>";
}
function updateBulkReview(){
  if(S.role!=="manager")return;
  const boxes=[...document.querySelectorAll("#recordsTable .record-select")];
  const checked=boxes.filter(x=>x.checked);
  $("recordSelectedCount").textContent=checked.length+" selected";
  $("markSelectedChecked").disabled=checked.length===0;
  const master=$("selectVisibleRecords");
  if(master){
    master.checked=boxes.length>0&&checked.length===boxes.length;
    master.indeterminate=checked.length>0&&checked.length<boxes.length;
  }
}
async function markSelectedChecked(){
  if(S.role!=="manager")return;
  const ids=[...document.querySelectorAll("#recordsTable .record-select:checked")].map(x=>x.value);
  if(!ids.length)return;
  if(S.mode==="demo"){
    ids.forEach(id=>{const x=S.entries.find(e=>e.id===id);if(x){x.status="checked";x.reviewedBy=S.user.uid;x.reviewedAt=new Date().toISOString()}});
  }else{
    const f=S.fb,batch=f.writeBatch(f.db);
    ids.forEach(id=>batch.update(f.doc(f.db,"workEntries",id),{status:"checked",reviewedBy:S.user.uid,reviewedAt:f.serverTimestamp()}));
    await batch.commit();
  }
  await records();
}
function range(month){const a=month.split("-").map(Number);return {start:new Date(a[0],a[1]-1,1),end:new Date(a[0],a[1],1)}}
async function records(){
  if(!S.user)return;
  if(S.mode==="demo"){
    let a=S.entries.filter(x=>x.status!=="void"),m=$("recordMonth").value;if(m)a=a.filter(x=>x.workDate.startsWith(m));
    if($("recordLorry").value)a=a.filter(x=>x.lorryId===$("recordLorry").value);
    const dir=$("recordSort").value==="asc"?1:-1;a.sort((x,y)=>dir*(new Date(x.originalStart)-new Date(y.originalStart)));
    const st=S.page*25,p=a.slice(st,st+25);$("recordsTable").innerHTML=table(p);$("recordCount").textContent=a.length+" records";$("pageLabel").textContent="Page "+(S.page+1);$("prevPage").disabled=S.page===0;$("nextPage").disabled=st+25>=a.length;updateBulkReview();return;
  }
  const f=S.fb,m=$("recordMonth").value,q=[];if(m){const r=range(m);q.push(f.where("originalStart",">=",r.start.toISOString()),f.where("originalStart","<",r.end.toISOString()))}
  if($("recordLorry").value)q.push(f.where("lorryId","==",$("recordLorry").value));
  q.push(f.orderBy("originalStart",$("recordSort").value));if(S.page>0&&S.cursors[S.page])q.push(f.startAfter(S.cursors[S.page]));q.push(f.limit(26));
  try{const snap=await f.getDocs(f.query(f.collection(f.db,"workEntries"),...q)),docs=snap.docs.filter(d=>d.data().status!=="void"),vis=docs.slice(0,25),rows=vis.map(d=>({id:d.id,...d.data()}));$("recordsTable").innerHTML=table(rows);$("recordCount").textContent=rows.length+" shown";$("pageLabel").textContent="Page "+(S.page+1);$("prevPage").disabled=S.page===0;$("nextPage").disabled=docs.length<=25;if(docs.length>25&&vis.length)S.cursors[S.page+1]=vis[vis.length-1];updateBulkReview()}catch(e){$("recordsTable").innerHTML='<div style="padding:18px" class="muted">'+esc(e.message)+"</div>"}
}
async function review(){
  let rows=[];
  if(S.mode==="demo"){
    rows=S.entries.filter(x=>x.status==="pending"||x.status==="correction").slice(0,50);
  }else{
    const f=S.fb;
    try{
      const snap=await f.getDocs(f.query(
        f.collection(f.db,"workEntries"),
        f.where("status","in",["pending","correction"]),
        f.orderBy("originalStart","desc"),
        f.limit(50)
      ));
      rows=snap.docs.map(d=>({id:d.id,...d.data()}));
    }catch(e){$("reviewList").textContent=e.message;return}
  }
  $("reviewList").innerHTML=rows.length?rows.map(x=>{
    const oa=new Date(x.originalStart),ob=new Date(x.originalEnd),a=new Date(x.correctedStart||x.originalStart),b=new Date(x.correctedEnd||x.originalEnd);
    const correction=x.status==="correction",changed=!!x.correctedStart;
    const originalLine=changed?'<div class="muted">Original: '+fmtT(oa)+' → '+fmtT(ob)+(x.overnight?" next day":"")+'</div>':"";
    const reason=changed&&x.correctionReason?'<div class="muted">Reason: '+esc(x.correctionReason)+'</div>':"";
    const pay=" · "+money(x.totals?.amount);
    return '<article class="review-card" data-id="'+x.id+'"><strong>'+esc(ln(x.lorryId,x.lorryPlate))+'</strong><div class="muted">'+fmtD(a)+" · "+fmtT(a)+" → "+fmtT(b)+((x.correctedOvernight??x.overnight)?" next day":"")+" · "+Number(x.totals?.total||0).toFixed(2)+"h"+pay+'</div>'+originalLine+reason+'<div class="muted"><strong>Status:</strong> '+esc(correction?"Correction Required":"Pending Review")+'</div><div class="actions"><button class="secondary" data-status="checked">Mark Checked</button><button class="secondary" data-correct="1">'+(changed?"Edit Correction":"Correct Entry")+'</button>'+(!correction?'<button class="secondary" data-status="correction">Correction Required</button>':'')+(S.role==="manager"?'<button class="secondary" data-void="1">Void Entry</button>':'')+'</div></article>'
  }).join(""):"<p class='muted'>No pending or correction entries.</p>";
}
async function status(id,v){
  if(S.mode==="demo"){const x=S.entries.find(e=>e.id===id);if(x)x.status=v}else{const f=S.fb;await f.updateDoc(f.doc(f.db,"workEntries",id),{status:v,reviewedBy:S.user.uid,reviewedAt:f.serverTimestamp()})}await records();
}
async function voidEntry(id){
  if(S.role!=="manager")return;
  if(!confirm("Void this work entry? It will be excluded from normal records, reports, and overlap checks."))return;
  if(S.mode==="demo"){
    const x=S.entries.find(e=>e.id===id);if(x){x.status="void";x.voidedBy=S.user.uid;x.voidedAt=new Date().toISOString()}
  }else{
    const f=S.fb;
    await f.updateDoc(f.doc(f.db,"workEntries",id),{status:"void",voidedBy:S.user.uid,voidedAt:f.serverTimestamp()});
  }
  await records();await report();
}
async function getEntry(id){
  if(S.mode==="demo")return S.entries.find(x=>x.id===id)||null;
  const f=S.fb,s=await f.getDoc(f.doc(f.db,"workEntries",id));
  return s.exists()?{id:s.id,...s.data()}:null;
}
function correctionPreview(){
  const id=$("correctionEntryId").value,start=$("correctionStart").value,end=$("correctionEnd").value;
  if(!id||!start||!end){$("correctionPreview").innerHTML='<span class="muted">Choose corrected Start and End.</span>';return}
  const workDate=$("correctionDialog").dataset.workDate;
  try{
    const t=resolve(workDate,start,end),c=calc(t.start,t.end,$("correctionPH").checked);
    const p=["normal","ot","night"].filter(k=>c.totals[k]>0).map(k=>label(k)+": "+c.totals[k].toFixed(2)+"h").join(" · ");
    $("correctionPreview").innerHTML="<strong>"+c.totals.total.toFixed(2)+" hours · "+money(c.totals.amount)+"</strong><span class='muted'>"+esc(p)+"</span>";
  }catch(e){$("correctionPreview").textContent=e.message}
}
async function openCorrection(id){
  const x=await getEntry(id);if(!x)return alert("Work entry not found.");
  const oa=new Date(x.originalStart),ob=new Date(x.originalEnd),a=new Date(x.correctedStart||x.originalStart),b=new Date(x.correctedEnd||x.originalEnd);
  $("correctionEntryId").value=x.id;
  $("correctionDialog").dataset.workDate=x.workDate||dk(oa);
  $("correctionOriginal").textContent="Original: "+fmtD(oa)+" · "+fmtT(oa)+" → "+fmtT(ob)+(x.overnight?" next day":"");
  $("correctionLorry").innerHTML=options(S.lorries,"id","plate","");
  $("correctionLorry").value=x.lorryId;
  $("correctionStart").value=pad(a.getHours())+":"+pad(a.getMinutes());
  $("correctionEnd").value=pad(b.getHours())+":"+pad(b.getMinutes());
  $("correctionPH").checked=!!x.publicHolidayEntitled;
  $("correctionReason").value=x.correctionReason||"";
  correctionPreview();
  $("correctionDialog").showModal();
}
async function saveCorrection(e){
  e.preventDefault();
  const id=$("correctionEntryId").value,x=await getEntry(id);if(!x)return alert("Work entry not found.");
  const t=resolve(x.workDate||dk(new Date(x.originalStart)),$("correctionStart").value,$("correctionEnd").value);
  const publicHolidayEntitled=$("correctionPH").checked,c=calc(t.start,t.end,publicHolidayEntitled);
  const reason=$("correctionReason").value.trim();if(!reason)return alert("Enter a correction reason.");
  const patch={
    originalLorryId:x.originalLorryId||x.lorryId,
    originalPublicHolidayEntitled:x.originalPublicHolidayEntitled??x.publicHolidayEntitled??false,
    originalTotals:x.originalTotals||x.totals,
    originalSegments:x.originalSegments||x.segments,
    lorryId:$("correctionLorry").value,
    lorryPlate:S.lorries.find(l=>l.id===$("correctionLorry").value)?.plate||x.lorryPlate||"",
    publicHolidayEntitled,
    correctedStart:t.start.toISOString(),
    correctedEnd:t.end.toISOString(),
    correctedStartTime:$("correctionStart").value,
    correctedEndTime:$("correctionEnd").value,
    correctedOvernight:t.overnight,
    correctionReason:reason,
    totals:c.totals,
    segments:c.segments,
    status:"checked"
  };
  if(S.mode==="demo"){
    Object.assign(x,patch,{correctedBy:S.user.uid,correctedAt:new Date().toISOString()});
  }else{
    const f=S.fb;
    await f.updateDoc(f.doc(f.db,"workEntries",id),{...patch,correctedBy:S.user.uid,correctedAt:f.serverTimestamp(),reviewedBy:S.user.uid,reviewedAt:f.serverTimestamp()});
  }
  $("correctionDialog").close();
  await review();await records();await report();
}
function aggByLorry(rows){
  const m=new Map;
  rows.forEach(x=>{
    const k=x.lorryId||"unknown";
    if(!m.has(k))m.set(k,{key:k,normal:0,ot:0,night:0,total:0,amount:0});
    const a=m.get(k),t=x.totals||{};
    ["normal","ot","night","total","amount"].forEach(z=>a[z]+=Number(t[z]||0));
  });
  return [...m.values()].map(x=>({...x,normal:Number(x.normal.toFixed(2)),ot:Number(x.ot.toFixed(2)),night:Number(x.night.toFixed(2)),total:Number(x.total.toFixed(2)),amount:Number(x.amount.toFixed(2))}));
}
function grandTotal(rows){
  const g={key:"all",normal:0,ot:0,night:0,total:0,amount:0};
  rows.forEach(x=>["normal","ot","night","total","amount"].forEach(k=>g[k]+=Number(x[k]||0)));
  ["normal","ot","night","total","amount"].forEach(k=>g[k]=Number(g[k].toFixed(2)));
  return g;
}
async function loadReportRows(){
  const m=$("reportMonth").value,lorryId=$("reportLorry").value;
  let rows=[];
  if(S.mode==="demo"){
    rows=S.entries.filter(x=>x.status!=="void"&&(!m||x.workDate.startsWith(m))&&(!lorryId||x.lorryId===lorryId));
  }else{
    const f=S.fb,r=range(m);
    const s=await f.getDocs(f.query(
      f.collection(f.db,"workEntries"),
      f.where("originalStart",">=",r.start.toISOString()),
      f.where("originalStart","<",r.end.toISOString()),
      f.orderBy("originalStart","asc")
    ));
    rows=s.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=="void"&&(!lorryId||x.lorryId===lorryId));
  }
  return rows;
}
async function report(){
  try{
    const rows=await loadReportRows();
    S.reportRows=rows;

    const selected=$("reportLorry").value;
    const per=aggByLorry(rows);
    const visible=selected?per.filter(x=>x.key===selected):per;
    const grand=grandTotal(visible);
    S.reportSummaryRows=selected?visible:[...visible,grand];

    const amountCard='<div class="summary-card"><span class="muted">Total amount</span><b>'+money(grand.amount)+'</b></div>';
    $("reportSummary").innerHTML='<div class="summary-grid">'+
      '<div class="summary-card"><span class="muted">Normal hours</span><b>'+grand.normal.toFixed(2)+'</b></div>'+
      '<div class="summary-card"><span class="muted">OT hours</span><b>'+grand.ot.toFixed(2)+'</b></div>'+
      '<div class="summary-card"><span class="muted">Night Shift hours</span><b>'+grand.night.toFixed(2)+'</b></div>'+
      '<div class="summary-card"><span class="muted">Total hours</span><b>'+grand.total.toFixed(2)+'</b></div>'+
      amountCard+
    '</div>';

    if(!rows.length){
      $("reportTable").innerHTML="<div style='padding:18px' class='muted'>No records for this month.</div>";
      return;
    }

    const grouped=new Map();
    rows.slice().sort((a,b)=>new Date(a.correctedStart||a.originalStart)-new Date(b.correctedStart||b.originalStart)).forEach(x=>{
      const key=x.lorryId||"unknown";
      if(!grouped.has(key))grouped.set(key,[]);
      grouped.get(key).push(x);
    });

    const detailAmountHead="<th>Amount</th>";
    const subtotalAmountHead="<th>Total Amount</th>";
    let html="";

    for(const [lorryId,items] of grouped){
      const subtotal=aggByLorry(items)[0]||{normal:0,ot:0,night:0,total:0,amount:0};
      html+='<h3 style="margin-top:18px">'+esc(ln(lorryId,items[0]?.lorryPlate))+'</h3>';
      html+='<table><thead><tr><th>Date</th><th>Shift</th><th>Start</th><th>End</th><th>Normal hrs</th><th>OT hrs</th><th>Night Shift hrs</th><th>Total hrs</th>'+detailAmountHead+'</tr></thead><tbody>';
      html+=items.map(x=>{
        const st=new Date(x.correctedStart||x.originalStart),en=new Date(x.correctedEnd||x.originalEnd),t=x.totals||{};
        const amountCell="<td>"+money(t.amount)+"</td>";
        const endDisplay=(x.correctedOvernight??x.overnight)?fmtD(en)+" "+fmtT(en):fmtT(en);
        return "<tr><td>"+esc(fmtD(st))+"</td><td>"+esc(x.shiftLabel||("Shift "+(x.shiftNo||"?")))+"</td><td>"+esc(fmtT(st))+"</td><td>"+esc(endDisplay)+"</td><td>"+Number(t.normal||0).toFixed(2)+"</td><td>"+Number(t.ot||0).toFixed(2)+"</td><td>"+Number(t.night||0).toFixed(2)+"</td><td>"+Number(t.total||0).toFixed(2)+"</td>"+amountCell+"</tr>";
      }).join("");
      html+='</tbody></table>';
      const summaryLabel=selected?"Total":"Subtotal";
      html+='<table style="margin-top:8px"><thead><tr><th>'+summaryLabel+'</th><th>Normal hrs</th><th>OT hrs</th><th>Night Shift hrs</th><th>Total hrs</th>'+subtotalAmountHead+'</tr></thead><tbody><tr><td>'+esc(ln(lorryId,items[0]?.lorryPlate))+'</td><td>'+subtotal.normal.toFixed(2)+'</td><td>'+subtotal.ot.toFixed(2)+'</td><td>'+subtotal.night.toFixed(2)+'</td><td>'+subtotal.total.toFixed(2)+'</td>'+"<td>"+money(subtotal.amount)+"</td>"+'</tr></tbody></table>';
    }

    if(!selected&&visible.length>1){
      html+='<h3 style="margin-top:22px">Grand Total</h3><table><thead><tr><th>Scope</th><th>Normal hrs</th><th>OT hrs</th><th>Night Shift hrs</th><th>Total hrs</th>'+subtotalAmountHead+'</tr></thead><tbody><tr><td>All Lorries</td><td>'+grand.normal.toFixed(2)+'</td><td>'+grand.ot.toFixed(2)+'</td><td>'+grand.night.toFixed(2)+'</td><td>'+grand.total.toFixed(2)+'</td>'+"<td>"+money(grand.amount)+"</td>"+'</tr></tbody></table>';
    }

    $("reportTable").innerHTML=html;
  }catch(e){
    $("reportTable").innerHTML='<div style="padding:18px" class="muted">'+esc(e.message)+"</div>";
  }
}
function reportExportMatrix(){
  const month=$("reportMonth").value||"";
  const selected=$("reportLorry").value;
  const rows=(S.reportRows||[]).slice().sort((a,b)=>new Date(a.correctedStart||a.originalStart)-new Date(b.correctedStart||b.originalStart));
  const aoa=[["Lorry System Report"],["Month",month||"All"],[]];
  const grouped=new Map();
  rows.forEach(x=>{
    const key=x.lorryId||"unknown";
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(x);
  });

  for(const [lorryId,items] of grouped){
    aoa.push([ln(lorryId,items[0]?.lorryPlate)]);
    const headers=["Date","Shift","Start","End","Normal Hours","OT Hours","Night Shift Hours","Total Hours"];
    headers.push("Amount (RM)");
    aoa.push(headers);
    items.forEach(x=>{
      const st=new Date(x.correctedStart||x.originalStart),en=new Date(x.correctedEnd||x.originalEnd),t=x.totals||{};
      const endDisplay=(x.correctedOvernight??x.overnight)?fmtD(en)+" "+fmtT(en):fmtT(en);
      const row=[fmtD(st),x.shiftLabel||("Shift "+(x.shiftNo||"?")),fmtT(st),endDisplay,Number(t.normal||0),Number(t.ot||0),Number(t.night||0),Number(t.total||0)];
      row.push(Number(t.amount||0));
      aoa.push(row);
    });
    const sub=aggByLorry(items)[0]||{normal:0,ot:0,night:0,total:0,amount:0};
    const subtotal=[selected?"Total":"Subtotal","", "", "",sub.normal,sub.ot,sub.night,sub.total];
    subtotal.push(sub.amount);
    aoa.push(subtotal,[]);
  }

  if(!selected&&grouped.size>1){
    const grand=grandTotal(aggByLorry(rows));
    const g=["Grand Total","","","",grand.normal,grand.ot,grand.night,grand.total];
    g.push(grand.amount);
    aoa.push(g);
  }
  return {month,aoa};
}
async function exportExcel(){
  if(!S.reportSummaryRows.length)return alert("No report data to export.");
  const XLSX=await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  const {month,aoa}=reportExportMatrix();
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"]=[{wch:20},{wch:14},{wch:14},{wch:18},{wch:14},{wch:14},{wch:18},{wch:14},{wch:18}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Report");
  XLSX.writeFile(wb,"lorry-report-"+(month||"all")+".xlsx");
}
async function loadScript(src){
  return new Promise((resolve,reject)=>{
    const existing=[...document.scripts].find(s=>s.src===src);
    if(existing){if(existing.dataset.loaded==="1")return resolve();existing.addEventListener("load",resolve,{once:true});existing.addEventListener("error",reject,{once:true});return}
    const s=document.createElement("script");s.src=src;s.async=true;
    s.onload=()=>{s.dataset.loaded="1";resolve()};s.onerror=reject;document.head.appendChild(s);
  });
}
async function exportPdf(){
  if(!S.reportRows.length)return alert("No report data to export.");
  await loadScript("https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js");
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});
  const {month,aoa}=reportExportMatrix();
  let y=14;
  doc.setFontSize(14);
  doc.text("Lorry System Report",14,y);y+=7;
  doc.setFontSize(9);
  doc.text("Month: "+(month||"All"),14,y);y+=8;
  const colX=[14,48,78,102,128,154,183,216,246];
  for(const row of aoa.slice(3)){
    if(y>190){doc.addPage();y=16}
    const isSection=row.length===1&&row[0];
    if(isSection){
      doc.setFont(undefined,"bold");
      doc.text(String(row[0]),14,y);
      doc.setFont(undefined,"normal");
      y+=7;continue;
    }
    if(row.length===0){y+=4;continue}
    const first=String(row[0]??"");
    const header=first==="Date";
    const total=first==="Total"||first==="Subtotal"||first==="Grand Total";
    if(header||total)doc.setFont(undefined,"bold");
    row.forEach((v,i)=>{
      if(v===undefined||v===null||v==="")return;
      const txt=typeof v==="number"?Number(v).toFixed(2):String(v);
      doc.text(txt,colX[i]||14,y);
    });
    if(header||total)doc.setFont(undefined,"normal");
    y+=6;
  }
  doc.save("lorry-report-"+(month||"all")+".pdf");
}
function settingsUI(){const s=S.settings;["normalStart","normalEnd","saturdayEnd","lunchStart","lunchEnd","nightStart","nightEnd","normalRate","otRate","nightRate"].forEach(k=>{if($(k))$(k).value=s[k]});$("lorryList").innerHTML=S.lorries.map(x=>'<span class="chip">'+esc(x.plate)+"</span>").join("");$("holidayList").innerHTML=S.holidays.sort((a,b)=>a.date.localeCompare(b.date)).map(x=>'<span class="chip">'+esc(x.date)+" · "+esc(x.name)+"</span>").join("")}
async function saveSettings(e){e.preventDefault();const n={normalStart:$("normalStart").value,normalEnd:$("normalEnd").value,saturdayEnd:$("saturdayEnd").value,lunchStart:$("lunchStart").value,lunchEnd:$("lunchEnd").value,nightStart:$("nightStart").value,nightEnd:$("nightEnd").value,normalRate:Number($("normalRate").value),otRate:Number($("otRate").value),nightRate:Number($("nightRate").value)};S.settings=n;if(S.mode==="firebase"){const f=S.fb;await f.setDoc(f.doc(f.db,"settings","global"),n,{merge:true})}settingsUI();alert("Settings saved.")}
async function addMaster(type,value){value=value.trim();if(!value)return;const data=type==="lorries"?{plate:value,active:true}:{name:value,active:true};if(S.mode==="firebase"){const f=S.fb,r=await f.addDoc(f.collection(f.db,type),data);S[type].push({id:r.id,...data})}else S[type].push({id:String(Date.now()),...data});selectors();settingsUI()}
async function addHoliday(date,name){if(S.mode==="firebase"){const f=S.fb;await f.setDoc(f.doc(f.db,"holidays",date),{date,name})}const h=S.holidays.find(x=>x.date===date);if(h)h.name=name;else S.holidays.push({id:date,date,name});settingsUI()}
function view(name){document.querySelectorAll(".view").forEach(x=>x.classList.add("hidden"));$("view-"+name).classList.remove("hidden");document.querySelectorAll(".tabs button").forEach(x=>x.classList.toggle("active",x.dataset.view===name));if(name==="records")records();if(name==="reports")report()}
function wire(){
  $("loginForm").onsubmit=async e=>{
    e.preventDefault();
    if(!configured())return;
    const email=$("loginEmail").value.trim(),password=$("loginPassword").value;
    $("loginError").classList.add("hidden");
    try{
      await S.fb.signInWithEmailAndPassword(S.fb.auth,email,password);
      e.target.reset();
    }catch(err){
      const code=err?.code||"";
      const messages={
        "auth/invalid-credential":"Email or password is incorrect, or this account has no Email/Password sign-in.",
        "auth/user-not-found":"This email is not registered in Firebase Authentication.",
        "auth/wrong-password":"The password is incorrect.",
        "auth/operation-not-allowed":"Email/Password sign-in is not enabled in Firebase Authentication.",
        "auth/user-disabled":"This Firebase Authentication user is disabled.",
        "auth/too-many-requests":"Too many failed attempts. Try again later.",
        "auth/network-request-failed":"Network error while contacting Firebase."
      };
      $("loginError").textContent=messages[code]||("Sign in failed"+(code?" ("+code+")":"")+".");
      $("loginError").classList.remove("hidden");
      console.error("Firebase email login error:",err);
    }
  };
  $("googleLoginBtn").onclick=async()=>{
    try{
      await S.fb.signInWithPopup(S.fb.auth,new S.fb.GoogleAuthProvider());
    }catch(err){
      const code=err?.code||"";
      const messages={
        "auth/operation-not-allowed":"Google sign-in is not enabled in Firebase Authentication.",
        "auth/unauthorized-domain":"This website domain is not authorized for Google sign-in in Firebase.",
        "auth/popup-blocked":"The browser blocked the Google sign-in popup.",
        "auth/popup-closed-by-user":"Google sign-in was cancelled."
      };
      $("loginError").textContent=messages[code]||("Google sign in failed"+(code?" ("+code+")":"")+".");
      $("loginError").classList.remove("hidden");
      console.error("Firebase Google login error:",err);
    }
  };
  $("signOutBtn").onclick=async()=>{await S.fb.signOut(S.fb.auth)};
  $("activeLorry").onchange=e=>{S.activeLorryId=e.target.value;localStorage.setItem("drivers.activeLorry",S.activeLorryId)};
  document.querySelectorAll(".tabs button").forEach(x=>x.onclick=()=>view(x.dataset.view));
  $("addEntryRow").onclick=()=>addEntryRow({},true);
  $("entryRows").onclick=e=>{const b=e.target.closest(".remove-entry-row");if(b){b.closest(".entry-row").remove();refreshEntryRows()}};
  $("workForm").onsubmit=submit;
  $("recordApply").onclick=()=>{S.page=0;S.cursors=[null];records()};
  $("recordMonth").onchange=()=>{S.page=0;S.cursors=[null];records()};
  $("recordLorry").onchange=()=>{S.page=0;S.cursors=[null];records()};
  $("recordSort").onchange=()=>{S.page=0;S.cursors=[null];records()};
  $("nextPage").onclick=()=>{S.page++;records()};$("prevPage").onclick=()=>{if(S.page>0)S.page--;records()};
  $("recordsTable").onclick=e=>{
    const selectAll=e.target.closest("#selectVisibleRecords");
    if(selectAll){document.querySelectorAll("#recordsTable .record-select").forEach(x=>x.checked=selectAll.checked);updateBulkReview();return}
    if(e.target.closest(".record-select")){updateBulkReview();return}
    const row=e.target.closest("tr[data-record-id]");
    if(!row)return;
    const id=row.dataset.recordId;
    const v=e.target.closest("[data-void]");if(v){voidEntry(id);return}
    const cr=e.target.closest("[data-correct]");if(cr){openCorrection(id);return}
    const b=e.target.closest("[data-status]");if(b)status(id,b.dataset.status)
  };
  $("markSelectedChecked").onclick=markSelectedChecked;
  $("correctionForm").onsubmit=saveCorrection;
  $("correctionClose").onclick=()=>$("correctionDialog").close();
  $("correctionCancel").onclick=()=>$("correctionDialog").close();
  ["correctionStart","correctionEnd"].forEach(id=>$(id).oninput=correctionPreview);
  $("correctionPH").onchange=correctionPreview;
  $("reportMonth").onchange=report;
  $("reportLorry").onchange=report;
  $("exportExcel").onclick=exportExcel;
  $("exportPdf").onclick=exportPdf;
  $("settingsForm").onsubmit=saveSettings;$("lorryForm").onsubmit=async e=>{e.preventDefault();await addMaster("lorries",$("lorryPlate").value);e.target.reset()};$("holidayForm").onsubmit=async e=>{e.preventDefault();await addHoliday($("holidayDate").value,$("holidayName").value.trim());e.target.reset()};
}
wire();
if(!configured()){$("setupBanner").classList.remove("hidden");$("setupBanner").innerHTML="<strong>Firebase not configured yet.</strong> Add the Firebase Web App values in <code>firebase-config.js</code>.";showLogin()}
else initFirebase().catch(e=>{$("setupBanner").classList.remove("hidden");$("setupBanner").textContent="Firebase startup error: "+e.message;showLogin()});
