(()=>{
  'use strict';
  const post=async(path,body={},token='')=>{
    const input=body&&typeof body==='object'?body:{};
    const routed=window.AccountingDomainApi?.route(path,input)||{path,body:input};
    const payload=token?{...routed.body,token}:routed.body;
    const response=await fetch(routed.path,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}
    catch{data={ok:false,message:`서버 응답 오류(HTTP ${response.status})`}}
    if(!response.ok||!data?.ok){
      const error=Object.assign(new Error(data?.message||'요청 처리에 실패했습니다.'),{status:response.status,data});
      throw error;
    }
    return data;
  };
  window.AccountingApiClient=Object.freeze({post});
})();
