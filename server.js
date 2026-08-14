const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

function extractItemId(url){
  const patterns=[
    /\/p\/(MLB\d{6,})/i,
    /\b(MLB\d{6,})\b/i
  ];
  for(const p of patterns){const m=url.match(p); if(m) return m[1].toUpperCase();}
  return null;
}

async function resolveUrl(input){
  const r=await fetch(input,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0'}});
  const loc=r.headers.get('location');
  if(loc) return new URL(loc,input).href;
  if(r.status>=300 && r.status<400) throw new Error('Redirecionamento sem destino');
  return input;
}

async function resolveChain(input){
  let current=input;
  for(let i=0;i<5;i++){
    const next=await resolveUrl(current);
    if(next===current) return current;
    current=next;
  }
  return current;
}

app.post('/api/offer', async(req,res)=>{
  try{
    const {url}=req.body||{};
    if(!url) return res.status(400).json({error:'Cole um link.'});
    let finalUrl=await resolveChain(url.trim());
    let id=extractItemId(finalUrl);
    if(!id){
      // Alguns links de produto usam /MLB-...; tente também um endpoint de short URL do ML.
      const rr=await fetch('https://api.mercadolibre.com/sites/MLB/search?q='+encodeURIComponent(finalUrl));
      if(rr.ok){const data=await rr.json(); if(data.results?.[0]?.id) id=data.results[0].id;}
    }
    if(!id) return res.status(422).json({error:'Não consegui identificar o anúncio depois de resolver o link.',finalUrl});
    const itemR=await fetch('https://api.mercadolibre.com/items/'+id);
    if(!itemR.ok) throw new Error('Mercado Livre não retornou o anúncio.');
    const item=await itemR.json();
    let old=item.original_price && Number(item.original_price)>Number(item.price)?Number(item.original_price):null;
    let actual=Number(item.price||0);
    try{
      const pr=await fetch('https://api.mercadolibre.com/items/'+id+'/prices');
      if(pr.ok){const data=await pr.json(); const promos=(data.prices||[]).filter(x=>x.type==='promotion'&&x.regular_amount&&Number(x.amount)>0); if(promos.length){const p=promos.find(x=>Number(x.amount)===actual)||promos[0]; actual=Number(p.amount); old=Number(p.regular_amount);}}
    }catch{}
    const image=item.pictures?.[0]?.url||item.thumbnail||'';
    const discount=old&&old>actual?Math.round((1-actual/old)*100):0;
    res.json({id,finalUrl,title:item.title,image,actual,old,discount});
  }catch(e){res.status(500).json({error:e.message||'Erro inesperado'});}
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log('Ofertão rodando na porta '+PORT));
