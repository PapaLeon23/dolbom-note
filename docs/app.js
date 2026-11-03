/* 지호-수호 돌봄노트 — GitHub Pages + Firebase / 관리자·시터 권한 / 아이별 전달사항 */
(() => {
  'use strict';
  const DEMO_UID = 'demo-sitter';
  const DEFAULT_SETTINGS = { child1:'지호', child2:'수호', payrollStartDay:26 };
  const DEFAULT_SITTER = { uid:DEMO_UID, name:'시터님', hourlyRate:15000,
    rateHistory:[{from:'2000-01-01',rate:15000}], assignedChildren:['child1','child2'], active:true };
  const FIREBASE_CONFIG = window.SITTER_FIREBASE_CONFIG || {};
  const cloudMode = Boolean(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.authDomain && FIREBASE_CONFIG.appId);
  const STORAGE_KEY = 'dolbom-note-v3-data';
  const formatter = new Intl.NumberFormat('ko-KR');
  const weekdays = ['일','월','화','수','목','금','토'];
  const els = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id,el]));
  const state = {
    role:'admin',user:null,month:new Date(new Date().getFullYear(),new Date().getMonth(),1),
    settings:{...DEFAULT_SETTINGS}, sitters:new Map(), roleSitterUids:new Set(), activeSitterUid:DEMO_UID,
    shifts:new Map(), localAllShifts:new Map(), notices:{}, medicationRecords:new Map(), medications:{}, medicationDate:"", medDraft:[], medLoadToken:0, unsubMedications:[], modal:{date:'',extraMinutes:0,original:null},
    firebase:null,auth:null,db:null,unsubSettings:null,unsubSitters:null,unsubRoles:null,unsubShifts:null,
    unsubNotices:[],historyMonths:6,pending:false,bulkScope:'period',bulkWeekdays:new Set([1,2,3,4,5]),periodInitialized:false
  };
  let toastTimer;
  const $ = id => els[id];
  const pad = n => String(n).padStart(2,'0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const monthKey = () => `${state.month.getFullYear()}-${pad(state.month.getMonth()+1)}`;
  const parseDate = key => {const [y,m,d]=key.split('-').map(Number);return new Date(y,m-1,d);};
  const validDate = key => typeof key==='string' && /^\d{4}-\d{2}-\d{2}$/.test(key) && dateKey(parseDate(key))===key;
  const money = n => `${formatter.format(Math.round(n))}원`;
  const won = n => `₩${formatter.format(Math.round(n))}`;
  const escapeHtml = value => String(value??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const prettyDate = key => {const [y,m,d]=key.split('-').map(Number);return `${y}.${pad(m)}.${pad(d)}`;};
  const monthDays = () => new Date(state.month.getFullYear(),state.month.getMonth()+1,0).getDate();
  const endTime = extra => {const m=1110+extra;return `${pad(Math.floor(m/60))}:${pad(m%60)}`;};
  function kstParts(now=new Date()) {
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
    const v=Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    return {date:`${v.year}-${pad(v.month)}-${pad(v.day)}`,minute:v.hour*60+v.minute};
  }
  const todayKey = () => kstParts().date;
  const isAdmin = () => state.role==='admin';
  const sitter = () => state.sitters.get(state.activeSitterUid)||null;
  const assignedIds = () => Array.isArray(sitter()?.assignedChildren)?sitter().assignedChildren:[];
  const assignedNames = () => assignedIds().map(id=>state.settings[id] || (id==='child1'?'첫째':'둘째'));
  const canViewWork = () => Boolean(sitter() && (isAdmin() || (state.activeSitterUid===state.user?.uid || !cloudMode) && assignedIds().length>0));
  function boundary(y,m,d){return new Date(y,m,Math.min(d,new Date(y,m+1,0).getDate()));}
  function settlementPeriod(month=state.month,cutoff=state.settings.payrollStartDay){
    const y=month.getFullYear(),m=month.getMonth(),d=Number(cutoff)||26;
    const start=d===1?boundary(y,m,1):boundary(y,m-1,d);
    const following=d===1?boundary(y,m+1,1):boundary(y,m,d);
    const end=new Date(following.getFullYear(),following.getMonth(),following.getDate()-1);
    return {start:dateKey(start),end:dateKey(end)};
  }
  function settlementMonthForToday(){
    const today=parseDate(todayKey()),day=state.settings.payrollStartDay;
    const starts=boundary(today.getFullYear(),today.getMonth(),day);
    return new Date(today.getFullYear(),today.getMonth()+(day>1 && today>=starts?1:0),1);
  }
  function periodLabel(){const d=state.settings.payrollStartDay;return d===1?'매월 1일 ~ 말일':`매월 ${d}일 ~ 다음 달 ${d-1}일`;}
  function rateForDate(key,person=sitter()){
    if(!person) return 0;
    const history=Array.isArray(person.rateHistory)?[...person.rateHistory].sort((a,b)=>a.from.localeCompare(b.from)):[];
    let rate=Number(person.hourlyRate)||0;
    if(history.length){rate=history[0].rate;for(const item of history)if(item.from<=key)rate=item.rate;}
    return Number(rate)||0;
  }
  const isDayOff = shift => shift?.careType==='off';
  const careMinutes = shift => isDayOff(shift)?0:(120+(Number(shift.extraMinutes)||0));
  const careKind = shift => isDayOff(shift)?'휴무':shift.extraMinutes>0?'하원 + 추가 돌봄':'하원';
  const amount = shift => (careMinutes(shift)/60)*rateForDate(shift.date);
  function effectiveStatus(shift){
    if(isDayOff(shift))return 'off';
    if(shift.status==='paid'||shift.status==='completed')return shift.status;
    const kst=kstParts();return shift.date<kst.date||(shift.date===kst.date&&kst.minute>=1200)?'completed':'scheduled';
  }
  const statusNames={scheduled:'돌봄 예정',completed:'돌봄 완료',paid:'지급 완료',off:'휴무'};
  function getPeriodShifts(){
    if(!canViewWork())return[];
    const {start,end}=settlementPeriod();return [...state.shifts.values()].filter(s=>s.date>=start&&s.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
  }
  function toast(message,error=false){
    clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').classList.add('show');
    toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3400);
  }
  function handleError(error,fallback){
    console.error(error);const code=String(error?.code||'');
    toast(code.includes('permission-denied')?'권한이 없습니다. Firestore 규칙·UID·역할을 확인해주세요.':code.includes('unavailable')?'네트워크 연결을 확인해주세요.':fallback,true);
  }
  function setPending(p){state.pending=p;['saveShift','deleteShift','confirmBulk','saveSettings','saveMapping','saveNotice','deleteNotice','saveMedication','addMedication','loginButton'].forEach(id=>{if($(id))$(id).disabled=p;});}
  function showScreen(screen){$('authScreen').hidden=screen!=='auth';$('unassignedScreen').hidden=screen!=='unassigned';$('app').hidden=screen!=='app';}
  function openModal(id){$(id).hidden=false;const panel=$(id).querySelector('.modal-card');if(panel)panel.scrollTop=0;document.body.style.overflow='hidden';}
  function closeModal(id){$(id).hidden=true;if([...document.querySelectorAll('.modal-overlay')].every(el=>el.hidden))document.body.style.overflow='';}
  function closeAllModals(){document.querySelectorAll('.modal-overlay').forEach(el=>el.hidden=true);document.body.style.overflow='';}
  function saveLocal(){if(cloudMode)return;localStorage.setItem(STORAGE_KEY,JSON.stringify({settings:state.settings,sitters:[...state.sitters.values()],shifts:[...state.localAllShifts.values()],notices:state.notices,medicationRecords:[...state.medicationRecords.entries()],activeSitterUid:state.activeSitterUid}));}
  function loadLocal(){
    try{
      const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
      if(raw){
        state.settings={...DEFAULT_SETTINGS,...raw.settings};
        state.sitters=new Map((raw.sitters||[]).filter(s=>s?.uid).map(s=>[s.uid,s]));
        state.activeSitterUid=raw.activeSitterUid||DEMO_UID;
        state.localAllShifts=new Map((raw.shifts||[]).filter(s=>validDate(s.date)).map(s=>[`${s.sitterUid||DEMO_UID}__${s.date}`,s]));
        state.shifts=new Map([...state.localAllShifts.values()].filter(s=>(s.sitterUid||DEMO_UID)===state.activeSitterUid).map(s=>[s.date,s]));
        state.notices=raw.notices||{};
        state.medicationRecords=new Map(Array.isArray(raw.medicationRecords)?raw.medicationRecords:[]);
        if(state.sitters.size)return;
      }
      // v2 체험판을 사용했다면 데이터·이름·정산기간을 가져옵니다.
      const old=JSON.parse(localStorage.getItem('care-note-settings-v1')||'{}');
      const oldShifts=JSON.parse(localStorage.getItem('care-note-shifts-v1')||'[]');
      state.settings={child1:old.child1||DEFAULT_SETTINGS.child1,child2:old.child2||DEFAULT_SETTINGS.child2,payrollStartDay:old.payrollStartDay||26};
      const person={...DEFAULT_SITTER,name:old.sitterName||'시터님',hourlyRate:old.hourlyRate||15000,
        rateHistory:[{from:'2000-01-01',rate:old.hourlyRate||15000}],
        assignedChildren:[old.child1Assigned===false?null:'child1',old.child2Assigned===false?null:'child2'].filter(Boolean)};
      state.sitters=new Map([[DEMO_UID,person]]);
      state.localAllShifts=new Map((Array.isArray(oldShifts)?oldShifts:[]).filter(s=>validDate(s.date)).map(s=>[`${DEMO_UID}__${s.date}`,{...s,sitterUid:DEMO_UID}]));
      state.shifts=new Map([...state.localAllShifts.values()].map(s=>[s.date,s]));
    }catch(error){console.warn('체험판 데이터 읽기 실패',error);state.sitters=new Map([[DEMO_UID,{...DEFAULT_SITTER}]]);}
    if(!state.sitters.size)state.sitters.set(DEMO_UID,{...DEFAULT_SITTER});
  }
  function render(){
    const person=sitter(),shifts=getPeriodShifts(),careShifts=shifts.filter(s=>!isDayOff(s));
    const totalMinutes=careShifts.reduce((sum,s)=>sum+careMinutes(s),0);
    const paid=careShifts.filter(s=>effectiveStatus(s)==='paid').reduce((sum,s)=>sum+amount(s),0);
    const completed=careShifts.filter(s=>effectiveStatus(s)==='completed').reduce((sum,s)=>sum+amount(s),0);
    const planned=careShifts.filter(s=>effectiveStatus(s)==='scheduled').reduce((sum,s)=>sum+amount(s),0);
    const earned=paid+completed,possible=earned+planned,rate=person?rateForDate(todayKey()):0;
    $('greeting').innerHTML=isAdmin()?'우리집 돌봄 일정 <span class="heading-heart">✳</span>':`${escapeHtml(person?.name||'시터님')}의 돌봄 일정 <span class="heading-heart">✳</span>`;
    $('subtitle').textContent=isAdmin()?'시터별 시급·돌봄 일정과 아이별 전달사항을 관리하세요.':'상단의 아이별 전달사항과 돌봄 일정·완료 급여를 확인하세요.';
    $('adminTools').hidden=!isAdmin();$('mobileAdd').hidden=!isAdmin();
    $('roleIndicator').textContent=isAdmin()?'관리자 전용':'시터 조회 전용';
    $('demoSwitch').hidden=cloudMode;$('demoBanner').hidden=cloudMode;$('logoutButton').hidden=!cloudMode;
    document.querySelectorAll('.view-toggle').forEach(b=>b.classList.toggle('active',b.dataset.role===state.role));
    $('sitterSelectorWrap').hidden=!isAdmin();
    if(isAdmin()){
      const options=[...state.sitters.values()].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
      const uids=[...new Set([...state.roleSitterUids,...options.map(s=>s.uid)])];
      $('activeSitter').innerHTML=uids.length?uids.map(uid=>{
        const p=state.sitters.get(uid);
        const label=p?`${p.name} (${uid.slice(0,8)}…)`:`미설정 시터 (${uid.slice(0,8)}…)`;
        return `<option value="${escapeHtml(uid)}">${escapeHtml(label)}</option>`;
      }).join(''):'<option value="">등록된 시터 계정 없음</option>';
      $('activeSitter').value=uids.includes(state.activeSitterUid)?state.activeSitterUid:'';
      $('sitterSetupHint').hidden=!state.activeSitterUid||Boolean(person);
    }
    // 왼쪽: 정산기간에 등록된 일정 전체. 오른쪽: 완료(자동·수동) 및 지급 완료된 일정.
    $('totalPay').textContent=won(possible);
    $('earnedPay').textContent=won(earned);
    const period=settlementPeriod();
    $('rateHint').textContent=person?`현재 시급 ${money(rate)} · ${prettyDate(period.start)} ~ ${prettyDate(period.end)} 기준`:'시터 연결 후 돌봄표를 생성하세요';
    const doneShifts=careShifts.filter(s=>effectiveStatus(s)!=='scheduled');
    const futureShifts=careShifts.filter(s=>effectiveStatus(s)==='scheduled');
    const hours=xs=>(xs.reduce((sum,s)=>sum+careMinutes(s),0)/60).toLocaleString('ko-KR',{maximumFractionDigits:1});
    $('doneCount').textContent=String(doneShifts.length);
    $('doneHours').textContent=hours(doneShifts);
    $('futureCount').textContent=String(futureShifts.length);
    $('futureHours').textContent=hours(futureShifts);
    $('monthTitle').textContent=`${state.month.getFullYear()}년 ${state.month.getMonth()+1}월`;
    $('cutoffInfo').textContent=periodLabel();
    // 배정된 아이만 이름으로 표시합니다. (미배정 아이의 번호 아이콘은 표시하지 않습니다.)
    const careNames=person?assignedNames():[];
    $('childrenLabel').innerHTML=careNames.length
      ?careNames.map(name=>`<span class="care-child-pill">${escapeHtml(name)}</span>`).join('')
      :'<span class="care-child-empty">연결된 아이 없음</span>';
    renderPaymentHistory();
    $('calendarTip').textContent='달력은 표시 월 전체, 정산은 상단의 기간 기준입니다.';
    $('listCount').textContent=String(shifts.length);
    renderNotices();renderMedications();renderCalendar();renderShiftList(shifts);
  }
  // 현재 정산 월을 기준으로 직전 6개월 또는 12개월의 실제 지급 처리 이력.
  // 화면에서 이전/다음 달로 이동해도 과거 지급 이력의 기준일은 오늘(KST)로 고정합니다.
  function renderPaymentHistory(){
    const n=state.historyMonths===12?12:6;
    const current=settlementMonthForToday();
    const all=canViewWork()?[...state.shifts.values()]:[];
    let grandTotal=0;
    const rows=[];
    for(let back=1;back<=n;back++){
      const month=new Date(current.getFullYear(),current.getMonth()-back,1);
      const period=settlementPeriod(month);
      const paidShifts=all.filter(s=>s.date>=period.start&&s.date<=period.end&&s.status==='paid');
      const sum=paidShifts.reduce((total,s)=>total+amount(s),0);
      grandTotal+=sum;
      rows.push(`<div class="payment-history-row">
        <div class="payment-history-period"><strong>${month.getFullYear()}년 ${month.getMonth()+1}월</strong><small>${prettyDate(period.start)} ~ ${prettyDate(period.end)}</small></div>
        <div class="payment-history-value"><strong class="${paidShifts.length?'':'zero'}">${money(sum)}</strong><small>${paidShifts.length?`${paidShifts.length}일 지급`:'지급 기록 없음'}</small></div>
      </div>`);
    }
    $('paymentHistoryList').innerHTML=rows.join('');
    $('paymentHistoryList').classList.toggle('history-long',n===12);
    $('paymentHistoryTotalLabel').textContent=`최근 ${n}개월 지급 총액`;
    $('paymentHistoryTotal').textContent=money(grandTotal);
    document.querySelectorAll('[data-history-months]').forEach(btn=>{
      const active=Number(btn.dataset.historyMonths)===n;
      btn.classList.toggle('active',active);
      btn.setAttribute('aria-pressed',String(active));
    });
  }
  function renderNotices(){
    const today=todayKey();
    $('noticeToday').textContent=prettyDate(today);
    const items=assignedIds().map(id=>({id,n:state.notices[id]})).filter(x=>x.n && x.n.forDate===today && (x.n.message||x.n.supplies));
    $('noticeItems').innerHTML=items.length?items.map(({id,n})=>`<div class="notice-item"><div class="notice-item-head"><strong>${escapeHtml(state.settings[id]||id)}</strong><span class="notice-date">오늘</span></div>${n.message?`<div class="notice-message">${escapeHtml(n.message)}</div>`:''}${n.supplies?`<div class="notice-supplies">준비물 · ${escapeHtml(n.supplies)}</div>`:''}</div>`).join(''):'<div class="empty-attention">오늘은 별다른 알림 사항이 없습니다.</div>';
  }
  function renderMedications(){
    const today=todayKey();
    const entries=assignedIds().flatMap(id=>{
      const record=cloudMode?state.medications[id]:state.medicationRecords.get(`${id}__${today}`);
      const items=record?.items||[];
      return items.map(item=>({...item,childId:id}));
    }).sort((a,b)=>a.time.localeCompare(b.time));
    $('medicationItems').innerHTML=entries.length?entries.map(item=>`<div class="medication-item"><div class="medication-item-head"><strong>${escapeHtml(state.settings[item.childId]||item.childId)}</strong><span class="med-time">${escapeHtml(item.time)}</span></div><div class="med-name">${escapeHtml(item.medicine)}</div>${item.dose?`<div class="med-instruction">투약 방법 · ${escapeHtml(item.dose)}</div>`:''}${item.note?`<div class="med-note">${escapeHtml(item.note)}</div>`:''}</div>`).join(''):'<div class="empty-attention">오늘 등록된 투약 요청이 없습니다.</div>';
  }
  function renderCalendar(){
    const year=state.month.getFullYear(),m=state.month.getMonth(),n=monthDays(),first=new Date(year,m,1).getDay();
    let html='';for(let i=0;i<first;i++)html+='<div class="day-cell empty" aria-hidden="true"></div>';
    const period=settlementPeriod();
    for(let d=1;d<=n;d++){
      const date=`${year}-${pad(m+1)}-${pad(d)}`,s=canViewWork()?state.shifts.get(date):null,status=s?effectiveStatus(s):'scheduled';
      const dow=new Date(year,m,d).getDay(),tag=dow===0?'sunday':dow===6?'saturday':'';
      const kind=s?(isDayOff(s)?'휴무':(s.extraMinutes?`+${s.extraMinutes}분`:'하원')):'일정 없음';
      html+=`<button type="button" class="day-cell ${tag} ${date>=period.start&&date<=period.end?'':'outside-period'} ${date===todayKey()?'today':''}" data-date="${date}" aria-label="${date}, ${kind}"><span class="day-num">${d}</span>${s?`<span class="day-tag ${status}">${kind}</span>${isDayOff(s)?'':`<span class="day-pay">${money(amount(s))}</span>`}`:(isAdmin()?'<span class="day-empty-plus">+</span>':'')}</button>`;
    }
    for(let i=0;i<(7-(first+n)%7)%7;i++)html+='<div class="day-cell empty" aria-hidden="true"></div>';
    $('calendar').innerHTML=html;
  }
  function renderShiftList(shifts){
    if(!shifts.length){$('shiftList').innerHTML=`<div class="empty-list"><div class="empty-illustration">☼</div><strong>등록된 돌봄 일정이 없어요</strong><p>${isAdmin()?'시터를 선택하고 ‘월 돌봄표 만들기’로 등록하세요.':'이 정산기간에 연결된 돌봄 일정이 없습니다.'}</p></div>`;return;}
    $('shiftList').innerHTML=shifts.map(s=>{
      const d=parseDate(s.date),status=effectiveStatus(s);
      return `<div class="shift-row" role="button" tabindex="0" data-date="${s.date}" aria-label="${s.date} 돌봄 상세보기"><div class="date-label">${d.getMonth()+1}월 ${d.getDate()}일 <span>(${weekdays[d.getDay()]})</span></div><div class="shift-type ${isDayOff(s)?'off':(s.extraMinutes?'extra':'')}">${careKind(s)}</div><div class="shift-time">${isDayOff(s)?'돌봄 없음':`16:30 – ${endTime(s.extraMinutes)}`}</div><div class="shift-amount">${money(amount(s))}</div><div><span class="status-chip ${status}">${statusNames[status]}</span></div><div class="row-chevron">›</div></div>`;
    }).join('');
  }
  function changeMonth(delta){state.month=new Date(state.month.getFullYear(),state.month.getMonth()+delta,1);render();}
  function openDay(date,allowChange=false){
    if(!validDate(date))return;
    const s=state.shifts.get(date);
    if(!isAdmin()&&(!canViewWork()||!s)){toast('해당 날짜에 등록된 돌봄 일정이 없습니다.');return;}
    state.modal={date,careType:s?.careType||(s?.extraMinutes>0?'extended':'pickup'),extraMinutes:s?.extraMinutes||0,original:s?{...s}:null};
    $('shiftDate').value=date;
    $('shiftDate').min=s&&!date.startsWith(monthKey())?date:`${monthKey()}-01`;
    $('shiftDate').max=s&&!date.startsWith(monthKey())?date:`${monthKey()}-${pad(monthDays())}`;
    $('shiftDate').disabled=!isAdmin()||!allowChange||!!s;
    $('shiftStatus').value=s?.status||'scheduled';$('shiftMemo').value=s?.memo||'';
    $('dayModalTitle').textContent=`${parseDate(date).getMonth()+1}월 ${parseDate(date).getDate()}일 · ${weekdays[parseDate(date).getDay()]}요일`;
    $('deleteShift').hidden=!isAdmin()||!s;$('dayModalActions').hidden=!isAdmin();
    for(const id of ['baseType','extraType','offType','decreaseExtra','increaseExtra','shiftStatus','shiftMemo'])$(id).disabled=!isAdmin();
    refreshDayPreview();openModal('dayModal');
  }
  function refreshDayPreview(){
    const extra=state.modal.extraMinutes,type=state.modal.careType,plus=type==='extended',off=type==='off';
    $('baseType').classList.toggle('active',type==='pickup');$('extraType').classList.toggle('active',plus);$('offType').classList.toggle('active',off);
    $('extraField').hidden=!plus;$('extraMinutesText').textContent=`${extra}분`;
    $('decreaseExtra').disabled=!isAdmin()||extra<=30;$('increaseExtra').disabled=!isAdmin()||extra>=360;
    $('shiftStatusField').hidden=off;
    if(off)$('shiftStatus').value='scheduled';
    $('previewTime').textContent=off?'휴무 · 돌봄 없음':`16:30 – ${endTime(extra)}`;
    $('previewPay').textContent=off?'0원':money(((120+extra)/60)*rateForDate($('shiftDate').value));
  }
  const shiftDocId=(uid,date)=>`${uid}__${date}`;
  async function saveShift(){
    if(!isAdmin()||state.pending||!sitter()){toast('먼저 시터를 등록·선택하세요.',true);return;}
    const date=$('shiftDate').value,period=settlementPeriod();
    if(!validDate(date)||(!date.startsWith(monthKey())&&(date<period.start||date>period.end))){toast('현재 달 또는 선택 정산기간의 날짜를 선택하세요.',true);return;}
    const careType=state.modal.careType,extra=careType==='extended'?state.modal.extraMinutes:0,status=careType==='off'?'scheduled':$('shiftStatus').value,memo=$('shiftMemo').value.trim();
    if(!['pickup','extended','off'].includes(careType)||!Number.isInteger(extra)||extra<0||extra>360||extra%30||(careType==='extended'&&extra<30)||!['scheduled','completed','paid'].includes(status)||memo.length>500)return;
    const wasPaid=state.modal.original?.status==='paid',oldType=state.modal.original?.careType||(state.modal.original?.extraMinutes>0?'extended':'pickup');
    if(wasPaid&&(oldType!==careType||state.modal.original.extraMinutes!==extra)&&!confirm('이미 지급 완료된 돌봄의 유형·시간이 변경되어 급여 내역에 영향을 줍니다. 계속할까요?'))return;
    const shift={date,sitterUid:state.activeSitterUid,start:'16:30',careType,extraMinutes:extra,status,memo};
    setPending(true);
    try{
      if(cloudMode)await state.firebase.setDoc(state.firebase.doc(state.db,'schedules',shiftDocId(shift.sitterUid,date)),{...shift,updatedAt:state.firebase.serverTimestamp()});
      else{state.shifts.set(date,shift);state.localAllShifts.set(shiftDocId(shift.sitterUid,date),shift);saveLocal();}
      closeModal('dayModal');render();toast('돌봄 일정이 저장되었습니다.');
    }catch(e){handleError(e,'돌봄 일정을 저장하지 못했습니다.');}finally{setPending(false);}
  }
  async function deleteShift(){
    if(!isAdmin()||state.pending||!state.shifts.has(state.modal.date))return;
    if(!confirm('돌봄 일정을 삭제하면 해당 날짜의 급여도 제외됩니다. 삭제할까요?'))return;
    setPending(true);
    try{
      const date=state.modal.date;
      if(cloudMode)await state.firebase.deleteDoc(state.firebase.doc(state.db,'schedules',shiftDocId(state.activeSitterUid,date)));
      else{state.shifts.delete(date);state.localAllShifts.delete(shiftDocId(state.activeSitterUid,date));saveLocal();}
      closeModal('dayModal');render();toast('일정이 삭제되었습니다.');
    }catch(e){handleError(e,'일정 삭제 실패');}finally{setPending(false);}
  }
  function pendingBulkDates(){
    const {start,end}=state.bulkScope==='period'?settlementPeriod():{start:`${monthKey()}-01`,end:`${monthKey()}-${pad(monthDays())}`};
    const dates=[];for(let d=parseDate(start);d<=parseDate(end);d.setDate(d.getDate()+1)){const key=dateKey(d);if(state.bulkWeekdays.has(d.getDay())&&!state.shifts.has(key))dates.push(key);}
    return dates;
  }
  function refreshBulk(){
    $('weekdaySelector').querySelectorAll('button').forEach(b=>b.classList.toggle('selected',state.bulkWeekdays.has(Number(b.dataset.weekday))));
    const {start,end}=state.bulkScope==='period'?settlementPeriod():{start:`${monthKey()}-01`,end:`${monthKey()}-${pad(monthDays())}`};
    $('bulkModalTitle').textContent=`${state.month.getMonth()+1}월 ${state.bulkScope==='period'?'정산기간':'달력'} 돌봄표 만들기`;
    $('bulkDescription').textContent=`${prettyDate(start)} ~ ${prettyDate(end)} 기간의 빈 날짜에 기본 하원 돌봄(16:30~18:30)를 등록합니다.`;
    const dates=pendingBulkDates(),pay=dates.reduce((sum,d)=>sum+rateForDate(d)*2,0);
    $('bulkSummary').textContent=`새로 생성할 날짜 ${dates.length}일 · 예상 급여 ${money(pay)}`;
    $('confirmBulk').disabled=state.pending||!dates.length;
  }
  function openBulk(){if(!isAdmin()||!sitter()){toast('먼저 시터를 등록·선택하세요.',true);return;}state.bulkScope='period';$('bulkScope').value='period';state.bulkWeekdays=new Set([1,2,3,4,5]);refreshBulk();openModal('bulkModal');}
  async function confirmBulk(){
    if(!isAdmin()||state.pending||!sitter())return;
    const dates=pendingBulkDates();if(!dates.length)return;
    setPending(true);
    try{
      if(cloudMode){
        const batch=state.firebase.writeBatch(state.db);
        for(const date of dates)batch.set(state.firebase.doc(state.db,'schedules',shiftDocId(state.activeSitterUid,date)),{date,sitterUid:state.activeSitterUid,start:'16:30',careType:'pickup',extraMinutes:0,status:'scheduled',memo:'',updatedAt:state.firebase.serverTimestamp()});
        await batch.commit();
      }else{for(const date of dates){const item={date,sitterUid:state.activeSitterUid,start:'16:30',careType:'pickup',extraMinutes:0,status:'scheduled',memo:''};state.shifts.set(date,item);state.localAllShifts.set(shiftDocId(item.sitterUid,date),item);}saveLocal();}
      closeModal('bulkModal');render();toast(`${dates.length}일 돌봄표를 생성했습니다.`);
    }catch(e){handleError(e,'돌봄표 생성 실패');}finally{setPending(false);}
  }
  function showSettingsTab(tab){
    const isSitter=tab==='sitters';
    $('settingsBasicTab').classList.toggle('active',!isSitter);
    $('settingsSitterTab').classList.toggle('active',isSitter);
    $('settingsBasicTab').setAttribute('aria-selected',String(!isSitter));
    $('settingsSitterTab').setAttribute('aria-selected',String(isSitter));
    $('settingsBasicPanel').hidden=isSitter;
    $('settingsSitterPanel').hidden=!isSitter;
    if(isSitter)refreshMappingList();
  }
  function openSettings(tab='basic'){
    if(!isAdmin())return;
    $('child1').value=state.settings.child1;$('child2').value=state.settings.child2;$('payrollStartDay').value=String(state.settings.payrollStartDay);
    refreshPayrollPreview();showSettingsTab(tab);openModal('settingsModal');
  }
  function refreshPayrollPreview(){
    const day=Number($('payrollStartDay').value)||26,p=settlementPeriod(state.month,day);
    $('payrollPreview').textContent=`${day===1?'매월 1일 ~ 말일':`매월 ${day}일 ~ 다음 달 ${day-1}일`} · 선택 월: ${prettyDate(p.start)} ~ ${prettyDate(p.end)}`;
  }
  async function saveSettings(){
    if(!isAdmin()||state.pending)return;
    const next={child1:$('child1').value.trim()||'첫째',child2:$('child2').value.trim()||'둘째',payrollStartDay:Number($('payrollStartDay').value)};
    if(next.child1.length>30||next.child2.length>30||!Number.isInteger(next.payrollStartDay)||next.payrollStartDay<1||next.payrollStartDay>31){toast('아이 이름과 정산 시작일을 확인하세요.',true);return;}
    if(next.payrollStartDay!==state.settings.payrollStartDay&&!confirm('정산 시작일을 바꾸면 과거 돌봄내역의 정산기간 구분도 바뀝니다. 계속할까요?'))return;
    setPending(true);
    try{
      if(cloudMode)await state.firebase.setDoc(state.firebase.doc(state.db,'settings','main'),{...next,updatedAt:state.firebase.serverTimestamp()});
      else{state.settings=next;saveLocal();}
      closeModal('settingsModal');render();toast('기본 설정을 저장했습니다.');
    }catch(e){handleError(e,'설정 저장 실패');}finally{setPending(false);}
  }
  function refreshMappingList(){
    const old=$('editSitterUid').value;
    const uids=[...new Set([...state.roleSitterUids,...state.sitters.keys()])];
    $('editSitterUid').innerHTML='<option value="">+ UID 직접 입력</option>'+uids.map(uid=>{
      const p=state.sitters.get(uid);
      return `<option value="${escapeHtml(uid)}">${p?escapeHtml(p.name):'미설정 시터'} (${escapeHtml(uid.slice(0,8))}…)</option>`;
    }).join('');
    $('editSitterUid').value=uids.includes(old)?old:(uids.includes(state.activeSitterUid)?state.activeSitterUid:'');
    $('sitterRoleHint').textContent=cloudMode
      ? (state.roleSitterUids.size?`sitter 권한 계정 ${state.roleSitterUids.size}개 확인 · 미설정 계정은 프로필 저장이 필요합니다.`:'sitter 권한 계정이 없다면 Firestore roles 문서 또는 규칙을 확인하세요. UID를 직접 입력할 수도 있습니다.')
      : '체험 모드에서는 임의의 시터 ID를 등록해볼 수 있습니다.';
    populateMappingForm();
  }
  function populateMappingForm(){
    const uid=$('editSitterUid').value,p=state.sitters.get(uid);
    $('sitterUid').value=p?.uid||uid||(cloudMode?'':DEMO_UID);
    $('sitterUid').readOnly=Boolean(p || (uid && state.roleSitterUids.has(uid)));
    $('mappingName').value=p?.name||'';$('mappingRate').value=p?rateForDate(todayKey(),p):15000;
    $('rateEffectiveDate').value=todayKey();
    $('assignChild1').checked=Boolean(p?.assignedChildren?.includes('child1'));
    $('assignChild2').checked=Boolean(p?.assignedChildren?.includes('child2'));
    $('assignChild1Label').textContent=state.settings.child1;$('assignChild2Label').textContent=state.settings.child2;
    $('uidHelp').textContent=cloudMode?'Firebase Authentication → 사용자 목록에서 시터 로그인 계정 UID를 복사합니다. 이메일 주소가 아닙니다.':'체험 모드 기본 시터 ID는 demo-sitter입니다. 새 ID도 등록할 수 있습니다.';
    refreshMappingPreview();
  }
  function refreshMappingPreview(){
    const count=Number($('assignChild1').checked)+Number($('assignChild2').checked),uid=$('sitterUid').value.trim();
    $('mappingPreview').textContent=`시터 ID: ${uid||'입력 필요'} · 연결할 아이 ${count}명 · 시급 ${money(Number($('mappingRate').value)||0)}`;
  }
  function openMapping(){openSettings('sitters');}
  async function saveMapping(){
    if(!isAdmin()||state.pending)return;
    const uid=$('sitterUid').value.trim(),name=$('mappingName').value.trim()||'시터님';
    const rate=Number($('mappingRate').value),effective=$('rateEffectiveDate').value;
    const children=['child1','child2'].filter((id,i)=>i===0?$('assignChild1').checked:$('assignChild2').checked);
    if(!/^[A-Za-z0-9_-]{2,128}$/.test(uid)){toast('Firebase 계정 UID를 정확하게 입력하세요.',true);return;}
    if(name.length>50||!Number.isInteger(rate)||rate<1000||rate>1000000||!validDate(effective)){toast('시터 이름·시급·적용일을 확인하세요.',true);return;}
    const old=state.sitters.get(uid),hist=old?.rateHistory?[...old.rateHistory]:[{from:'2000-01-01',rate}];
    if(old && rate!==rateForDate(effective,old)){
      if(!confirm(`${prettyDate(effective)}부터 시급을 ${money(rate)}으로 변경합니다. 적용일 이후 기록의 급여가 조정될 수 있습니다. 계속할까요?`))return;
      const pos=hist.findIndex(h=>h.from===effective);
      if(pos>=0)hist[pos]={from:effective,rate};else hist.push({from:effective,rate});
    }
    hist.sort((a,b)=>a.from.localeCompare(b.from));
    const next={uid,name,hourlyRate:rateHistoryCurrent(hist),rateHistory:hist,assignedChildren:children,active:children.length>0};
    setPending(true);
    try{
      if(cloudMode)await state.firebase.setDoc(state.firebase.doc(state.db,'sitters',uid),{name:next.name,hourlyRate:next.hourlyRate,rateHistory:next.rateHistory,assignedChildren:next.assignedChildren,active:next.active,updatedAt:state.firebase.serverTimestamp()});
      else{state.sitters.set(uid,next);state.activeSitterUid=uid;state.shifts=new Map([...state.localAllShifts.values()].filter(x=>x.sitterUid===uid).map(x=>[x.date,x]));saveLocal();}
      if(cloudMode){state.activeSitterUid=uid;}
      closeModal('settingsModal');render();toast('시터 정보와 아이 연결을 저장했습니다.');
    }catch(e){handleError(e,'시터 정보 저장 실패 (시터 역할 UID 확인)');}finally{setPending(false);}
  }
  function rateHistoryCurrent(history){let r=history[0]?.rate||15000;for(const v of history)if(v.from<=todayKey())r=v.rate;return r;}
  function openNotice(){
    if(!isAdmin())return;
    $('noticeChild').innerHTML=['child1','child2'].map(id=>`<option value="${id}">${escapeHtml(state.settings[id]||id)}</option>`).join('');
    $('noticeChild').value='child1';fillNotice();openModal('noticeModal');
  }
  function fillNotice(){
    const n=state.notices[$('noticeChild').value];
    $('noticeDate').value=n?.forDate||todayKey();
    $('noticeMessage').value=n?.message||'';$('noticeSupplies').value=n?.supplies||'';
  }
  async function saveNotice(){
    if(!isAdmin()||state.pending)return;
    const id=$('noticeChild').value,forDate=$('noticeDate').value,message=$('noticeMessage').value.trim(),supplies=$('noticeSupplies').value.trim();
    if(!['child1','child2'].includes(id)||!validDate(forDate)||message.length>600||supplies.length>300||(!message&&!supplies)){toast('날짜와 특이사항 또는 준비물을 입력하세요.',true);return;}
    setPending(true);
    try{
      if(cloudMode)await state.firebase.setDoc(state.firebase.doc(state.db,'notices',id),{forDate,message,supplies,updatedAt:state.firebase.serverTimestamp()});
      else{state.notices[id]={forDate,message,supplies};saveLocal();}
      closeModal('noticeModal');render();toast('아이별 전달사항을 저장했습니다.');
    }catch(e){handleError(e,'전달사항 저장 실패');}finally{setPending(false);}
  }
  async function deleteNotice(){
    if(!isAdmin()||state.pending)return;
    const id=$('noticeChild').value;if(!state.notices[id]){toast('등록된 전달사항이 없습니다.');return;}
    if(!confirm('선택한 아이의 전달사항을 삭제하시겠습니까?'))return;
    setPending(true);
    try{
      if(cloudMode)await state.firebase.deleteDoc(state.firebase.doc(state.db,'notices',id));
      else{delete state.notices[id];saveLocal();}
      closeModal('noticeModal');render();toast('전달사항을 삭제했습니다.');
    }catch(e){handleError(e,'전달사항 삭제 실패');}finally{setPending(false);}
  }
  function medDocRef(childId,day){return state.firebase.doc(state.db,'medications',childId,'days',day);}
  async function loadMedDraft(){
    const id=$('medicationChild').value,day=$('medicationDate').value;
    if(!['child1','child2'].includes(id)||!validDate(day))return;
    const token=++state.medLoadToken;
    state.medDraft=[];
    $('medicationDraftList').innerHTML='<div class="empty-attention">투약 요청을 불러오는 중입니다.</div>';
    $('addMedication').disabled=true;$('saveMedication').disabled=true;
    try{
      const record=cloudMode?(await state.firebase.getDoc(medDocRef(id,day))).data():state.medicationRecords.get(`${id}__${day}`);
      if(token!==state.medLoadToken||$('medicationModal').hidden)return;
      state.medDraft=Array.isArray(record?.items)?record.items.map(x=>({time:x.time,medicine:x.medicine,dose:x.dose||'',note:x.note||''})):[];
    }catch(e){if(token!==state.medLoadToken)return;handleError(e,'투약 요청 불러오기 실패');}
    finally{if(token===state.medLoadToken){$('addMedication').disabled=false;$('saveMedication').disabled=false;renderMedDraft();}}
  }
  function renderMedDraft(){
    $('medicationDraftCount').textContent=`${state.medDraft.length}건`;
    $('medicationDraftList').innerHTML=state.medDraft.length?state.medDraft.map((item,i)=>`<div class="med-draft-item"><div><strong>${escapeHtml(item.time)} · ${escapeHtml(item.medicine)}</strong><small>${escapeHtml(item.dose||'투약 방법 미입력')}</small>${item.note?`<small>${escapeHtml(item.note)}</small>`:''}</div><button type="button" class="btn btn-quiet btn-small" data-med-remove="${i}">삭제</button></div>`).join(''):'<div class="empty-attention">선택한 날짜에 등록된 투약 요청이 없습니다.</div>';
  }
  function openMedication(){
    if(!isAdmin())return;
    $('medicationChild').innerHTML=['child1','child2'].map(id=>`<option value="${id}">${escapeHtml(state.settings[id]||id)}</option>`).join('');
    $('medicationChild').value='child1';$('medicationDate').value=todayKey();
    $('medicationTime').value='17:00';$('medicationName').value='';$('medicationDose').value='';$('medicationNote').value='';
    openModal('medicationModal');loadMedDraft();
  }
  function addMedication(){
    if(!isAdmin()||state.pending)return;
    const time=$('medicationTime').value,medicine=$('medicationName').value.trim(),dose=$('medicationDose').value.trim(),note=$('medicationNote').value.trim();
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!medicine||medicine.length>80||dose.length>160||note.length>260){toast('투약 예정 시간과 약 이름을 확인해주세요.',true);return;}
    if(state.medDraft.length>=10){toast('하루에 등록할 수 있는 투약 요청은 최대 10건입니다.',true);return;}
    state.medDraft.push({time,medicine,dose,note});state.medDraft.sort((a,b)=>a.time.localeCompare(b.time));
    $('medicationName').value='';$('medicationDose').value='';$('medicationNote').value='';
    renderMedDraft();toast('요청을 목록에 추가했습니다. 아래 저장 버튼을 눌러 확정해주세요.');
  }
  async function saveMedication(){
    if(!isAdmin()||state.pending)return;
    const id=$('medicationChild').value,day=$('medicationDate').value;
    if(!['child1','child2'].includes(id)||!validDate(day)||state.medDraft.length>10){toast('아이·날짜·요청 건수를 확인해주세요.',true);return;}
    const items=state.medDraft.map(v=>({...v}));setPending(true);
    try{
      if(cloudMode){
        if(items.length)await state.firebase.setDoc(medDocRef(id,day),{items,updatedAt:state.firebase.serverTimestamp()});
        else await state.firebase.deleteDoc(medDocRef(id,day));
      }else{
        if(items.length)state.medicationRecords.set(`${id}__${day}`,{items});else state.medicationRecords.delete(`${id}__${day}`);
        saveLocal();
      }
      closeModal('medicationModal');render();toast(items.length?'투약 요청을 저장했습니다.':'선택한 날짜의 투약 요청을 삭제했습니다.');
    }catch(e){handleError(e,'투약 요청 저장 실패');}finally{setPending(false);}
  }
  function csvEscape(value){let s=String(value);if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  function downloadCSV(){
    if(!canViewWork()){toast('조회할 수 있는 돌봄표가 없습니다.',true);return;}
    const rows=[['시터 ID','시터 이름','날짜','요일','돌봄 유형','시작','종료','기본(시간)','추가(시간)','총 돌봄(시간)','적용 시급(원)','급여(원)','상태','메모']];
    for(const s of getPeriodShifts())rows.push([state.activeSitterUid,sitter()?.name||'',s.date,weekdays[parseDate(s.date).getDay()],careKind(s),isDayOff(s)?'':'16:30',isDayOff(s)?'':endTime(s.extraMinutes),isDayOff(s)?0:2,isDayOff(s)?0:s.extraMinutes/60,careMinutes(s)/60,rateForDate(s.date),amount(s),statusNames[effectiveStatus(s)],s.memo||'']);
    const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob),a=document.createElement('a'),p=settlementPeriod();
    a.href=url;a.download=`지호-수호_돌봄노트_${p.start}_${p.end}_${sitter()?.name||'시터'}_정산.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('CSV를 다운로드했습니다.');
  }
  function clearShiftSubscription(){if(state.unsubShifts)state.unsubShifts();state.unsubShifts=null;state.shifts=new Map();}
  function subscribeShifts(){
    clearShiftSubscription();render();if(!canViewWork())return;
    const uid=state.activeSitterUid;
    // UID 단독 질의: 다른 시터의 급여 데이터는 규칙과 쿼리 두 곳에서 접근 차단.
    const q=state.firebase.query(state.firebase.collection(state.db,'schedules'),state.firebase.where('sitterUid','==',uid));
    state.unsubShifts=state.firebase.onSnapshot(q,snap=>{
      if(uid!==state.activeSitterUid)return;
      state.shifts=new Map(snap.docs.map(doc=>[doc.data().date,doc.data()]));render();
    },error=>handleError(error,'돌봄표를 불러오지 못했습니다.'));
  }
  function subscribeNotices(){
    state.unsubNotices.forEach(fn=>fn());state.unsubNotices=[];state.notices={};
    if(!state.firebase||!canViewWork()){render();return;}
    for(const id of assignedIds()){
      const unsub=state.firebase.onSnapshot(state.firebase.doc(state.db,'notices',id),snap=>{
        if(!assignedIds().includes(id))return;
        if(snap.exists())state.notices[id]=snap.data();else delete state.notices[id];render();
      },error=>handleError(error,'전달사항을 불러오지 못했습니다.'));
      state.unsubNotices.push(unsub);
    }
    render();
  }
  function subscribeMedications(){
    state.unsubMedications.forEach(fn=>fn());state.unsubMedications=[];state.medications={};
    state.medicationDate=todayKey();
    if(!state.firebase||!canViewWork()){render();return;}
    const targetDay=state.medicationDate;
    for(const id of assignedIds()){
      const unsub=state.firebase.onSnapshot(medDocRef(id,targetDay),snap=>{
        if(targetDay!==state.medicationDate||!assignedIds().includes(id))return;
        if(snap.exists())state.medications[id]=snap.data();else delete state.medications[id];render();
      },e=>handleError(e,'투약 요청 정보를 불러오지 못했습니다.'));
      state.unsubMedications.push(unsub);
    }
    render();
  }
  function selectSitter(uid){
    if(!state.sitters.has(uid)&&!state.roleSitterUids.has(uid))return;
    state.activeSitterUid=uid;
    if(cloudMode){subscribeShifts();subscribeNotices();subscribeMedications();}else{state.shifts=new Map([...state.localAllShifts.values()].filter(x=>x.sitterUid===uid).map(x=>[x.date,x]));saveLocal();render();}
  }
  function onSitterChanges(records){
    const prev=state.activeSitterUid,oldIds=assignedIds().join(',');
    state.sitters=new Map(records.map(s=>[s.uid,s]));
    if(state.role==='sitter')state.activeSitterUid=state.user.uid;
    else if(!state.sitters.has(state.activeSitterUid)&&!state.roleSitterUids.has(state.activeSitterUid))
      state.activeSitterUid=state.roleSitterUids.values().next().value||state.sitters.keys().next().value||'';
    const changed=prev!==state.activeSitterUid||oldIds!==assignedIds().join(',');
    if(changed||!state.unsubShifts)subscribeShifts();else render();
    if(changed||!state.unsubNotices.length)subscribeNotices();
    if(changed||!state.unsubMedications.length)subscribeMedications();
  }
  function onRoleSittersChange(uids){
    state.roleSitterUids=new Set(uids);
    if(state.role==='admin'&&!state.activeSitterUid){
      state.activeSitterUid=uids[0]||state.sitters.keys().next().value||'';
    }
    render();
  }
  function releaseSubscriptions(){
    if(state.unsubSettings)state.unsubSettings();if(state.unsubSitters)state.unsubSitters();
    if(state.unsubRoles)state.unsubRoles();clearShiftSubscription();
    state.unsubNotices.forEach(fn=>fn());state.unsubNotices=[];
    state.unsubMedications.forEach(fn=>fn());state.unsubMedications=[];state.medications={};
    state.unsubSettings=null;state.unsubSitters=null;state.unsubRoles=null;
    state.roleSitterUids=new Set();state.notices={};state.sitters=new Map();
  }
  async function initFirebase(){
    try{
      const cdn='https://www.gstatic.com/firebasejs/13.1.0';
      const [app,auth,firestore]=await Promise.all([import(`${cdn}/firebase-app.js`),import(`${cdn}/firebase-auth.js`),import(`${cdn}/firebase-firestore.js`)]);
      state.firebase={...auth,...firestore};const firebaseApp=app.initializeApp(FIREBASE_CONFIG);
      state.db=firestore.getFirestore(firebaseApp);state.auth=auth.getAuth(firebaseApp);
      auth.onAuthStateChanged(state.auth,async user=>{
        releaseSubscriptions();closeAllModals();
        if(!user){state.user=null;showScreen('auth');return;}
        state.user=user;
        try{
          const roleDoc=await firestore.getDoc(firestore.doc(state.db,'roles',user.uid));
          if(state.user?.uid!==user.uid)return;
          const role=roleDoc.data()?.role;
          if(!['admin','sitter'].includes(role)){state.role='none';$('uidText').textContent=user.uid;showScreen('unassigned');return;}
          state.role=role;state.periodInitialized=false;state.activeSitterUid=role==='sitter'?user.uid:'';
          showScreen('app');
          state.unsubSettings=firestore.onSnapshot(firestore.doc(state.db,'settings','main'),snap=>{
            const oldCutoff=state.settings.payrollStartDay;
            state.settings={...DEFAULT_SETTINGS,...(snap.exists()?snap.data():{})};
            if(!state.periodInitialized){state.month=settlementMonthForToday();state.periodInitialized=true;}
            if(oldCutoff!==state.settings.payrollStartDay)render();else render();
          },error=>handleError(error,'기본 설정을 읽을 수 없습니다.'));
          if(role==='admin'){
            // Firebase 로그인 계정과 Firestore 역할은 별도입니다. 역할이 sitter인 UID를 자동으로 표시합니다.
            const q=firestore.query(firestore.collection(state.db,'roles'),firestore.where('role','==','sitter'));
            state.unsubRoles=firestore.onSnapshot(q,snap=>{
              onRoleSittersChange(snap.docs.map(doc=>doc.id));
            },error=>handleError(error,'시터 계정 목록을 읽지 못했습니다. Firestore Rules를 업데이트해주세요.'));
            state.unsubSitters=firestore.onSnapshot(firestore.collection(state.db,'sitters'),snap=>{
              onSitterChanges(snap.docs.map(doc=>({uid:doc.id,...doc.data()})));
            },error=>handleError(error,'시터 목록을 읽을 수 없습니다.'));
          }else{
            state.unsubSitters=firestore.onSnapshot(firestore.doc(state.db,'sitters',user.uid),snap=>{
              onSitterChanges(snap.exists()?[{uid:snap.id,...snap.data()}]:[]);
            },error=>handleError(error,'시터 배정 정보를 읽을 수 없습니다.'));
          }
        }catch(e){handleError(e,'로그인 권한을 확인하지 못했습니다.');$('uidText').textContent=user.uid;showScreen('unassigned');}
      });
    }catch(e){console.error(e);showScreen('auth');$('authError').textContent='Firebase에 연결하지 못했습니다. config.js 설정을 확인해주세요.';}
  }
  // Event listeners
  $('prevMonth').addEventListener('click',()=>changeMonth(-1));$('nextMonth').addEventListener('click',()=>changeMonth(1));
  $('activeSitter').addEventListener('change',e=>{if(isAdmin())selectSitter(e.target.value);});
  $('calendar').addEventListener('click',e=>{const x=e.target.closest('[data-date]');if(x)openDay(x.dataset.date);});
  $('shiftList').addEventListener('click',e=>{const x=e.target.closest('[data-date]');if(x)openDay(x.dataset.date);});
  $('shiftList').addEventListener('keydown',e=>{if(!['Enter',' '].includes(e.key))return;const x=e.target.closest('[data-date]');if(x){e.preventDefault();openDay(x.dataset.date);}});
  $('mobileAdd').addEventListener('click',()=>openDay(todayKey().startsWith(monthKey())?todayKey():`${monthKey()}-01`,true));
  $('bulkButton').addEventListener('click',openBulk);
  $('bulkScope').addEventListener('change',()=>{state.bulkScope=$('bulkScope').value==='calendar'?'calendar':'period';refreshBulk();});
  $('weekdaySelector').addEventListener('click',e=>{const b=e.target.closest('[data-weekday]');if(!b)return;const n=Number(b.dataset.weekday);if(state.bulkWeekdays.has(n))state.bulkWeekdays.delete(n);else state.bulkWeekdays.add(n);refreshBulk();});
  $('confirmBulk').addEventListener('click',confirmBulk);
  $('settingsButton').addEventListener('click',()=>openSettings('basic'));
  $('sitterSettingsShortcut').addEventListener('click',()=>openSettings('sitters'));
  $('settingsBasicTab').addEventListener('click',()=>showSettingsTab('basic'));
  $('settingsSitterTab').addEventListener('click',()=>showSettingsTab('sitters'));
  $('saveSettings').addEventListener('click',saveSettings);
  $('payrollStartDay').addEventListener('change',refreshPayrollPreview);
  $('editSitterUid').addEventListener('change',populateMappingForm);
  ['sitterUid','mappingRate','assignChild1','assignChild2'].forEach(id=>$(id).addEventListener('input',refreshMappingPreview));
  $('saveMapping').addEventListener('click',saveMapping);
  $('medicationButton').addEventListener('click',openMedication);
  $('medicationChild').addEventListener('change',loadMedDraft);$('medicationDate').addEventListener('change',loadMedDraft);
  $('addMedication').addEventListener('click',addMedication);$('saveMedication').addEventListener('click',saveMedication);
  $('medicationDraftList').addEventListener('click',e=>{if(!isAdmin())return;const b=e.target.closest('[data-med-remove]');if(!b)return;state.medDraft.splice(Number(b.dataset.medRemove),1);renderMedDraft();});
  $('noticeButton').addEventListener('click',openNotice);$('noticeChild').addEventListener('change',fillNotice);
  $('saveNotice').addEventListener('click',saveNotice);$('deleteNotice').addEventListener('click',deleteNotice);
  $('csvButton').addEventListener('click',downloadCSV);
  document.querySelectorAll('[data-history-months]').forEach(btn=>btn.addEventListener('click',()=>{state.historyMonths=Number(btn.dataset.historyMonths)===12?12:6;renderPaymentHistory();}));
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
  document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id);}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeAllModals();});
  $('baseType').addEventListener('click',()=>{if(!isAdmin())return;state.modal.careType='pickup';state.modal.extraMinutes=0;refreshDayPreview();});
  $('extraType').addEventListener('click',()=>{if(!isAdmin())return;state.modal.careType='extended';if(!state.modal.extraMinutes)state.modal.extraMinutes=30;refreshDayPreview();});
  $('offType').addEventListener('click',()=>{if(!isAdmin())return;state.modal.careType='off';state.modal.extraMinutes=0;refreshDayPreview();});
  $('decreaseExtra').addEventListener('click',()=>{if(!isAdmin())return;state.modal.extraMinutes=Math.max(30,state.modal.extraMinutes-30);refreshDayPreview();});
  $('increaseExtra').addEventListener('click',()=>{if(!isAdmin())return;state.modal.extraMinutes=Math.min(360,state.modal.extraMinutes+30);refreshDayPreview();});
  $('shiftDate').addEventListener('change',()=>{const next=$('shiftDate').value;if(!validDate(next)||!next.startsWith(monthKey()))return;closeModal('dayModal');openDay(next,true);});
  $('saveShift').addEventListener('click',saveShift);$('deleteShift').addEventListener('click',deleteShift);
  $('demoSwitch').addEventListener('click',e=>{
    const b=e.target.closest('[data-role]');if(!b||cloudMode)return;
    state.role=b.dataset.role;const selected=state.role==='sitter'?DEMO_UID:(state.activeSitterUid||DEMO_UID);
    state.activeSitterUid=selected;state.shifts=new Map([...state.localAllShifts.values()].filter(x=>x.sitterUid===selected).map(x=>[x.date,x]));closeAllModals();render();
  });
  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();if(!state.auth||state.pending)return;
    $('authError').textContent='';setPending(true);
    try{await state.firebase.signInWithEmailAndPassword(state.auth,$('loginEmail').value.trim(),$('loginPassword').value);}
    catch(err){console.error(err);$('authError').textContent='로그인 실패: 이메일과 비밀번호를 확인해주세요.';}finally{setPending(false);}
  });
  $('logoutButton').addEventListener('click',()=>state.auth&&state.firebase.signOut(state.auth));
  $('unassignedLogout').addEventListener('click',()=>state.auth&&state.firebase.signOut(state.auth));
  $('copyUid').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('uidText').textContent);toast('UID를 복사했습니다.');}catch{toast('UID를 직접 복사해주세요.',true);}});
  $('payrollStartDay').innerHTML=Array.from({length:31},(_,i)=>`<option value="${i+1}">매월 ${i+1}일</option>`).join('');
  // 열려 있는 웹페이지도 매분 상태가 갱신되며, 닫힌 동안의 과거 돌봄도 다음 접속 때 완료 처리됩니다.
  setInterval(()=>{if(!$('app').hidden){if(cloudMode && state.medicationDate!==todayKey())subscribeMedications();else render();}},60_000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('app').hidden){if(cloudMode && state.medicationDate!==todayKey())subscribeMedications();else render();}});
  if(cloudMode){showScreen('auth');initFirebase();}
  else{loadLocal();state.month=settlementMonthForToday();showScreen('app');render();}
})();
