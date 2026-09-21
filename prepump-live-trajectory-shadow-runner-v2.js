const fs=require("fs");

const JOURNAL_FILE="./prepump-live-trajectory-journal.json";
const HISTORY_FILE="./radar-history.json";

function runTrajectoryShadow(){

  function pct(a,b){
    if(a==null||b==null||a===0) return null;
    return ((b-a)/a)*100;
  }

  function n(v){
    const x=Number(v);
    return Number.isFinite(x)?x:null;
  }

  function featureAt(s,i){
    if(i<12) return null;

    const cur=s[i];
    const s6=s[i-6];
    const s12=s[i-12];

    const vg=pct(n(s6.volume),n(cur.volume));
    const vp=pct(n(s12.volume),n(s6.volume));
    const hg=pct(n(s6.holders),n(cur.holders));
    const hp=pct(n(s12.holders),n(s6.holders));
    const lg=pct(n(s6.liquidity),n(cur.liquidity));

    if([vg,vp,hg,hp,lg].some(v=>v==null)) return null;

    return {
      H:hg,
      HA:hg-hp,
      L:lg,
      VA:vg-vp
    };
  }

  function getCurrentEpisode(s){
    if(s.length<14) return [];

    const ep=[s[s.length-1]];

    for(let i=s.length-2;i>=0;i--){
      const gap=Number(s[i+1].time)-Number(s[i].time);
      if(gap>60) break;
      ep.unshift(s[i]);
    }

    return ep;
  }

  function futureOutcome(history,row,windowSec){
    const data=history.tokens?.[row.token];
    if(!data||!Array.isArray(data.snapshots)) return null;

    const signalTime=Number(row.signalTime);
    const signalPrice=Number(row.signalPrice);

    if(!Number.isFinite(signalPrice)||signalPrice<=0) return null;

    const future=data.snapshots.filter(s=>{
      const t=Number(s.time);
      const p=Number(s.price);

      return t>signalTime &&
             t<=signalTime+windowSec &&
             Number.isFinite(p)&&
             p>0;
    });

    if(!future.length) return null;

    const maxPrice=Math.max(...future.map(s=>Number(s.price)));
    const change=((maxPrice-signalPrice)/signalPrice)*100;

    return {
      maxChange:Number(change.toFixed(4)),
      plus10:change>=10,
      plus20:change>=20,
      samples:future.length,
      maxPrice,
      lastTime:Number(future[future.length-1].time)
    };
  }

  const history=JSON.parse(
    fs.readFileSync(HISTORY_FILE,"utf8")
  );

  if(!fs.existsSync(JOURNAL_FILE)){
    fs.writeFileSync(JOURNAL_FILE,"[]","utf8");
  }

  const journal=JSON.parse(
    fs.readFileSync(JOURNAL_FILE,"utf8")
  );

  const existing=new Set(
    journal.map(x=>x.key)
  );

  let candidates=0;
  let added=0;
  let outcomesUpdated=0;

  for(const [token,data] of Object.entries(history.tokens||{})){

    if(!data||!Array.isArray(data.snapshots)) continue;

    const s=data.snapshots;
    if(s.length<14) continue;

    const ep=getCurrentEpisode(s);
    if(ep.length<2) continue;

    const firstIndex=s.indexOf(ep[0]);
    const lastIndex=s.length-1;

    const first=featureAt(s,firstIndex);
    const last=featureAt(s,lastIndex);

    if(!first||!last) continue;

    const dH=last.H-first.H;
    const dHA=last.HA-first.HA;
    const dL=last.L-first.L;
    const dVA=last.VA-first.VA;

    if(!(dH>0&&dL<0)) continue;

    candidates++;

    const signalTime=Number(s[lastIndex].time);
    const signalPrice=Number(s[lastIndex].price);

    const key=token+":"+signalTime;

    if(!existing.has(key)){

      journal.push({
        key,
        token,
        signalTime,
        signalISO:new Date(signalTime*1000).toISOString(),
        signalPrice,

        episodeSignals:ep.length,
        episodeDuration:
          signalTime-Number(ep[0].time),

        features:{
          first,
          last,
          dH,
          dHA,
          dL,
          dVA
        },

        candidate:true,
        strict:dH>0&&dHA>0&&dL<0,

        result60:null,
        result120:null,
        result300:null,

        createdAt:new Date().toISOString()
      });

      existing.add(key);
      added++;
    }
  }

  for(const row of journal){

    if(row.result60==null){
      const r=futureOutcome(history,row,60);
      if(r){
        row.result60=r;
        outcomesUpdated++;
      }
    }

    if(row.result120==null){
      const r=futureOutcome(history,row,120);
      if(r){
        row.result120=r;
        outcomesUpdated++;
      }
    }

    if(row.result300==null){
      const r=futureOutcome(history,row,300);
      if(r){
        row.result300=r;
        outcomesUpdated++;
      }
    }
  }

  fs.writeFileSync(
    JOURNAL_FILE,
    JSON.stringify(journal,null,2),
    "utf8"
  );

  console.log(
    "[TRAJECTORY SHADOW]",
    "candidates="+candidates,
    "added="+added,
    "outcomeUpdates="+outcomesUpdated,
    "journal="+journal.length
  );
}

if(require.main===module){
  runTrajectoryShadow();
}

module.exports={runTrajectoryShadow};
